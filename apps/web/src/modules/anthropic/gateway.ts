import type Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import {
  AGENT_MODEL,
  AGENT_TOOLSET,
  MCP_SERVER_NAME,
  MEMORY_STORE_INSTRUCTIONS,
  SESSION_BUDGET_CENTS,
  SESSION_BUDGET_CURRENCY,
} from "./config";
import {
  advanceCursor,
  type EventCursor,
  eventsAfter,
  type SessionEvent,
  type SessionStatus,
} from "./events";

/**
 * The whole Managed Agents surface we depend on, behind one interface. Nothing
 * outside this module imports `@anthropic-ai/sdk`: the API is in beta, so when
 * it changes, this file changes and the router does not.
 */

/** One user-added connector, already reduced to what the API declares. */
export interface ConnectorServer {
  name: string;
  url: string;
}

export interface RegisterAgentInput {
  /** Assigned connectors, on top of the workspace server. */
  connectors?: readonly ConnectorServer[];
  instructions: string;
  /** Our MCP endpoint for this agent, resolved at call time from env. */
  mcpUrl: string;
  name: string;
  system: string;
}

export interface RegisteredAgent {
  anthropicAgentId: string;
  /** Null when the store could not be created; the agent still works, unaided. */
  memoryStoreId: string | null;
}

export interface SyncAgentInput {
  anthropicAgentId: string;
  /**
   * Assigned connectors. Only read when `mcpUrl` is given, because that is the
   * only time the whole `mcp_servers` array is replaced.
   */
  connectors?: readonly ConnectorServer[];
  /** Omit to leave the registered MCP URL untouched (the usual roster resync). */
  mcpUrl?: string;
  name: string;
  system: string;
}

export interface CreateSessionInput {
  anthropicAgentId: string;
  memoryStoreId: string | null;
  text: string;
  title: string;
  /**
   * Vaults holding the connectors' credentials. Create-only: a running session
   * cannot be given more, which is why an assignment lands on the next one.
   */
  vaultIds?: readonly string[];
}

export interface CreatedSession {
  sessionId: string;
  status: SessionStatus;
}

export interface PolledEvents {
  cursor: EventCursor | undefined;
  events: SessionEvent[];
}

export interface AnthropicGateway {
  createSession: (input: CreateSessionInput) => Promise<CreatedSession>;
  deleteSession: (sessionId: string) => Promise<void>;
  /** The one shared environment, created on first use and cached thereafter. */
  ensureEnvironment: () => Promise<string>;
  getSession: (sessionId: string) => Promise<SessionStatus>;
  pollEvents: (
    sessionId: string,
    cursor: EventCursor | undefined
  ) => Promise<PolledEvents>;
  registerAgent: (input: RegisterAgentInput) => Promise<RegisteredAgent>;
  sendMessage: (sessionId: string, text: string) => Promise<void>;
  syncAgent: (input: SyncAgentInput) => Promise<void>;
}

/** Where the environment id is remembered between requests. */
export interface EnvironmentCache {
  read: () => Promise<string | null>;
  write: (environmentId: string) => Promise<void>;
}

export interface GatewayOptions {
  cache: EnvironmentCache;
  environmentName: string;
}

const CONFLICT = 409;
const DESCRIPTION_MAX_LENGTH = 2048;

/**
 * Both toolsets are set to `always_allow` explicitly. The agent toolset
 * defaults that way, but an `mcp_toolset` left bare comes back from the API as
 * `always_ask` (verified 2026-08-20) - which would park every session in
 * `requires_action` waiting for a human to approve `post_message`, with nobody
 * watching. There is no human in this loop, so nothing may ask one.
 */
const permissive = {
  enabled: true,
  permission_policy: { type: "always_allow" as const },
};

const mcpToolset = (name: string) => ({
  default_config: permissive,
  mcp_server_name: name,
  type: "mcp_toolset" as const,
});

/**
 * Every declared server must be referenced by an `mcp_toolset`, so the two
 * arrays are built from the same list. Connectors are only present when the
 * workspace server is - `mcp_servers` is a full replacement, and sending the
 * connectors alone would drop the agent's own MCP endpoint.
 */
const toolsFor = (
  mcpUrl: string | undefined,
  connectors: readonly ConnectorServer[]
) => [
  {
    default_config: permissive,
    type: AGENT_TOOLSET as "agent_toolset_20260401",
  },
  ...(mcpUrl
    ? [
        mcpToolset(MCP_SERVER_NAME),
        ...connectors.map((connector) => mcpToolset(connector.name)),
      ]
    : []),
];

const mcpServersFor = (
  mcpUrl: string | undefined,
  connectors: readonly ConnectorServer[]
) =>
  mcpUrl
    ? [
        { name: MCP_SERVER_NAME, type: "url" as const, url: mcpUrl },
        ...connectors.map((connector) => ({
          name: connector.name,
          type: "url" as const,
          url: connector.url,
        })),
      ]
    : undefined;

const statusOf = (status: string): SessionStatus => {
  if (
    status === "idle" ||
    status === "running" ||
    status === "rescheduling" ||
    status === "terminated"
  ) {
    return status;
  }
  return "unknown";
};

const textOf = (event: BetaManagedAgentsSessionEvent): string | undefined => {
  if (event.type === "agent.message") {
    return event.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");
  }
  if (event.type === "session.error") {
    return event.error.message;
  }
};

const toSessionEvent = (
  event: BetaManagedAgentsSessionEvent
): SessionEvent => ({
  id: event.id,
  processedAt: "processed_at" in event ? (event.processed_at ?? null) : null,
  text: textOf(event),
  type: event.type,
});

const isConflict = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { status?: unknown }).status === CONFLICT;

const findEnvironmentByName = async (
  client: Anthropic,
  name: string
): Promise<string | null> => {
  for await (const environment of client.beta.environments.list()) {
    if (environment.name === name && environment.archived_at === null) {
      return environment.id;
    }
  }
  return null;
};

/**
 * Adopts the environment of that name, creating it only when there is none.
 *
 * Look-before-create rather than create-and-catch-409: the docs say
 * environment names are unique, but the live API (verified 2026-08-20 by
 * `scripts/anthropic-spike.ts`) happily creates duplicates, and every
 * duplicate eats one of the five concurrent-environment slots. The 409 branch
 * stays as a race guard in case the constraint is enforced later.
 */
const findOrCreateEnvironment = async (
  client: Anthropic,
  name: string
): Promise<string> => {
  const existing = await findEnvironmentByName(client, name);
  if (existing) {
    return existing;
  }

  try {
    const created = await client.beta.environments.create({
      config: { networking: { type: "unrestricted" }, type: "cloud" },
      name,
    });
    return created.id;
  } catch (error) {
    if (!isConflict(error)) {
      throw error;
    }
    const raced = await findEnvironmentByName(client, name);
    if (!raced) {
      throw error;
    }
    return raced;
  }
};

export const createAnthropicGateway = (
  client: Anthropic,
  options: GatewayOptions
): AnthropicGateway => {
  const ensureEnvironment = async (): Promise<string> => {
    const cached = await options.cache.read();
    if (cached) {
      return cached;
    }
    const environmentId = await findOrCreateEnvironment(
      client,
      options.environmentName
    );
    await options.cache.write(environmentId);
    return environmentId;
  };

  return {
    async createSession(input) {
      const environmentId = await ensureEnvironment();
      const session = await client.beta.sessions.create({
        agent: input.anthropicAgentId,
        budget: {
          max_list_cost: {
            amount: SESSION_BUDGET_CENTS,
            currency: SESSION_BUDGET_CURRENCY,
          },
          type: "limit",
        },
        environment_id: environmentId,
        initial_events: [
          {
            content: [{ text: input.text, type: "text" }],
            type: "user.message",
          },
        ],
        ...(input.vaultIds && input.vaultIds.length > 0
          ? { vault_ids: [...input.vaultIds] }
          : {}),
        ...(input.memoryStoreId
          ? {
              resources: [
                {
                  access: "read_write" as const,
                  instructions: MEMORY_STORE_INSTRUCTIONS,
                  memory_store_id: input.memoryStoreId,
                  type: "memory_store" as const,
                },
              ],
            }
          : {}),
        title: input.title,
      });
      return { sessionId: session.id, status: statusOf(session.status) };
    },

    async deleteSession(sessionId) {
      await client.beta.sessions.delete(sessionId);
    },

    ensureEnvironment,

    async getSession(sessionId) {
      const session = await client.beta.sessions.retrieve(sessionId);
      return statusOf(session.status);
    },

    async pollEvents(sessionId, cursor) {
      const page = await client.beta.sessions.events.list(sessionId, {
        order: "asc",
        ...(cursor?.lastProcessedAt
          ? { "created_at[gte]": cursor.lastProcessedAt }
          : {}),
      });

      const all: SessionEvent[] = [];
      for await (const event of page) {
        all.push(toSessionEvent(event));
      }

      const fresh = eventsAfter(all, cursor);
      return { cursor: advanceCursor(fresh, cursor), events: fresh };
    },

    async registerAgent(input) {
      // The agent first: it is the call that validates the configuration (a
      // loopback MCP URL is rejected here), and a memory store created before it
      // would be orphaned by that rejection - stores are workspace-scoped and
      // nothing would ever point at it again.
      const agent = await client.beta.agents.create({
        description:
          input.instructions.slice(0, DESCRIPTION_MAX_LENGTH) || undefined,
        mcp_servers: mcpServersFor(input.mcpUrl, input.connectors ?? []),
        model: AGENT_MODEL,
        name: input.name,
        system: input.system,
        tools: toolsFor(input.mcpUrl, input.connectors ?? []),
      });

      const store = await client.beta.memoryStores
        .create({
          description: `Long-term memory for the agent "${input.name}" in the Agentum workspace.`,
          name: `agentum-${input.name}`,
        })
        // The agent exists and must be recorded either way: forgetting its id
        // here would mean creating a second one on the next edit.
        .catch(() => null);

      return { anthropicAgentId: agent.id, memoryStoreId: store?.id ?? null };
    },

    async sendMessage(sessionId, text) {
      await client.beta.sessions.events.send(sessionId, {
        events: [{ content: [{ text, type: "text" }], type: "user.message" }],
      });
    },

    async syncAgent(input) {
      // Omitted fields are preserved, so a roster-only resync leaves the agent's
      // MCP registration alone - which matters, because the plaintext token that
      // URL carries only exists when it is issued.
      await client.beta.agents.update(input.anthropicAgentId, {
        model: AGENT_MODEL,
        name: input.name,
        system: input.system,
        ...(input.mcpUrl
          ? {
              mcp_servers: mcpServersFor(input.mcpUrl, input.connectors ?? []),
              tools: toolsFor(input.mcpUrl, input.connectors ?? []),
            }
          : {}),
      });
    },
  };
};
