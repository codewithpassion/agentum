import type Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import {
  AGENT_TOOLSET,
  DESKTOP_SCREENSHOT_DESCRIPTION,
  DESKTOP_SCREENSHOT_TOOL,
  MCP_SERVER_NAME,
  MEMORY_STORE_INSTRUCTIONS,
  SESSION_BUDGET_CENTS,
  SESSION_BUDGET_CURRENCY,
  WORKER_AGENT_DESCRIPTION,
  WORKER_AGENT_MODEL,
  WORKER_AGENT_NAME,
  WORKER_AGENT_SYSTEM,
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

/**
 * One assigned skill. `version` is either the literal `"latest"` - stored as
 * that string and resolved when a session is created - or a concrete Anthropic
 * version id (epoch microseconds) for a pinned assignment.
 */
export interface AgentSkillRef {
  skillId: string;
  version: string;
}

export interface RegisterAgentInput {
  /** See `SyncAgentInput.computerOnly`. */
  computerOnly?: boolean;
  /** Assigned connectors, on top of the workspace server. */
  connectors?: readonly ConnectorServer[];
  /** See `SyncAgentInput.desktop`. */
  desktop?: boolean;
  instructions: string;
  /** Our MCP endpoint for this agent, resolved at call time from env. */
  mcpUrl: string;
  /** The model to register the agent with; the caller resolves the default. */
  model: string;
  name: string;
  /** Assigned skills. Only non-empty when a prior registration attempt failed. */
  skills?: readonly AgentSkillRef[];
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
   * True for an agent bound to a remote computer: its built-in shell and file
   * tools are turned off. Without `mcpUrl` the registered MCP servers are read
   * back so the tools array can be rebuilt around them.
   */
  computerOnly?: boolean;
  /**
   * Assigned connectors. Only read when `mcpUrl` is given, because that is the
   * only time the whole `mcp_servers` array is replaced.
   */
  connectors?: readonly ConnectorServer[];
  /**
   * True when the agent's computer has a desktop. Declares the client-run
   * `desktop_screenshot` custom tool, the one way a picture reaches the model.
   * Only read together with `computerOnly`.
   */
  desktop?: boolean;
  /** Omit to leave the registered MCP URL untouched (the usual roster resync). */
  mcpUrl?: string;
  /**
   * Required, not optional: every update sends it, and a roster resync that
   * omitted it would quietly put a re-modelled agent back on the default.
   */
  model: string;
  name: string;
  system: string;
}

export interface CreateSessionInput {
  /** Null for an agent that has no Anthropic registration - the Cloudflare runtime. */
  anthropicAgentId: string | null;
  memoryStoreId: string | null;
  /** The model this session runs on, whatever the agent is registered with. */
  model: string;
  text: string;
  title: string;
  /**
   * Vaults holding the connectors' credentials. Create-only: a running session
   * cannot be given more, which is why an assignment lands on the next one.
   */
  vaultIds?: readonly string[];
}

/** What a sync changed that a running session cannot pick up. */
export interface SyncAgentResult {
  /** The agent's tool setup differs from the one it had; sessions must restart. */
  toolsChanged: boolean;
}

/**
 * The answer to one `agent.custom_tool_use`: text, and optionally the picture
 * the model should see.
 */
export interface CustomToolResult {
  image?: { base64: string; mediaType: "image/jpeg" };
  isError: boolean;
  text: string;
  toolUseId: string;
}

export interface CreatedSession {
  sessionId: string;
  status: SessionStatus;
}

export interface PolledEvents {
  cursor: EventCursor | undefined;
  events: SessionEvent[];
}

/**
 * A skills-only update. Its own method rather than a flag on `syncAgent`,
 * because what it must *not* carry is the point: `mcp_servers` (and the
 * one-time token in the workspace URL) stays exactly as registered, so an
 * agent that creates a skill mid-session does not sever its own MCP connection.
 */
export interface SyncAgentSkillsInput {
  anthropicAgentId: string;
  skills: readonly AgentSkillRef[];
}

/**
 * The part of the gateway the router drives: start a session, send into it,
 * read what it did. Both runtimes implement it - this file for Managed Agents,
 * `modules/runner/gateway` for the loop on Cloudflare - which is what lets the
 * router's pump treat the two alike.
 */
export interface SessionGateway {
  createSession: (input: CreateSessionInput) => Promise<CreatedSession>;
  deleteSession: (sessionId: string) => Promise<void>;
  getSession: (sessionId: string) => Promise<SessionStatus>;
  pollEvents: (
    sessionId: string,
    cursor: EventCursor | undefined
  ) => Promise<PolledEvents>;
  /** Managed Agents only; the Cloudflare runner has no client-run tools. */
  sendCustomToolResult?: (
    sessionId: string,
    result: CustomToolResult
  ) => Promise<void>;
  sendMessage: (sessionId: string, text: string) => Promise<void>;
}

/** One line of a session's transcript, text only. */
export interface TranscriptEntry {
  /** ISO 8601; null for an event still queued. */
  at: string | null;
  kind: "agent" | "tool_call" | "tool_result" | "user";
  /** Message text, a short summary of a call's input, or a truncated result. */
  text: string;
  /** The tool's name, on a call. */
  tool?: string;
}

export interface TranscriptPage {
  entries: TranscriptEntry[];
  /** Pass back to read the next page; null at the end. */
  nextCursor: string | null;
}

/** An Anthropic session as listed, before it has a history row. */
export interface ListedSession {
  createdAt: string;
  id: string;
  title: string | null;
  updatedAt: string;
}

export interface AnthropicGateway extends SessionGateway {
  /** The one shared environment, created on first use and cached thereafter. */
  ensureEnvironment: () => Promise<string>;
  /** One page of a session's transcript, oldest first. */
  listSessionEvents: (
    sessionId: string,
    options: { cursor?: string; limit: number }
  ) => Promise<TranscriptPage>;
  /** Every session created for one Anthropic agent, newest first. */
  listSessions: (anthropicAgentId: string) => Promise<ListedSession[]>;
  registerAgent: (input: RegisterAgentInput) => Promise<RegisteredAgent>;
  syncAgent: (input: SyncAgentInput) => Promise<SyncAgentResult>;
  syncAgentSkills: (input: SyncAgentSkillsInput) => Promise<void>;
}

/** Where an Anthropic-side id is remembered between requests. */
export interface IdCache {
  read: () => Promise<string | null>;
  write: (id: string) => Promise<void>;
}

export interface GatewayOptions {
  cache: IdCache;
  environmentName: string;
  /** Where the shared subagent worker's agent id is remembered. */
  workerCache: IdCache;
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
const BUILTIN_TOOLS_KEPT = ["web_fetch", "web_search"] as const;

/**
 * An agent bound to a remote computer works there, through our `computer_*`
 * tools. Its built-in shell and file tools would act on Anthropic's sandbox
 * instead, so they are off; only web access stays.
 */
const agentToolset = (computerOnly: boolean) => ({
  ...(computerOnly
    ? {
        configs: BUILTIN_TOOLS_KEPT.map((name) => ({ name, ...permissive })),
        default_config: { ...permissive, enabled: false },
      }
    : { default_config: permissive }),
  type: AGENT_TOOLSET as "agent_toolset_20260401",
});

/**
 * The model's only way to look at the desktop. A custom tool, because Managed
 * Agents does not show the model images from an MCP tool result but does show
 * them in a `user.custom_tool_result`. The router answers the call.
 */
const desktopScreenshotTool = {
  description: DESKTOP_SCREENSHOT_DESCRIPTION,
  input_schema: { properties: {}, type: "object" as const },
  name: DESKTOP_SCREENSHOT_TOOL,
  type: "custom" as const,
};

const toolsFor = (
  mcpUrl: string | undefined,
  connectors: readonly ConnectorServer[],
  computerOnly = false,
  desktop = false
) => [
  agentToolset(computerOnly),
  ...(mcpUrl
    ? [
        mcpToolset(MCP_SERVER_NAME),
        ...connectors.map((connector) => mcpToolset(connector.name)),
      ]
    : []),
  ...(computerOnly && desktop ? [desktopScreenshotTool] : []),
];

/** The built-ins the agent toolset switches on and off by name. */
const BUILTIN_TOOLS = [
  "bash",
  "edit",
  "glob",
  "grep",
  "read",
  "web_fetch",
  "web_search",
  "write",
] as const;

interface ToolLike {
  configs?: { enabled?: boolean; name: string }[] | null;
  default_config?: { enabled?: boolean } | null;
  mcp_server_name?: string;
  name?: string;
  type: string;
}

/**
 * What a tools array lets the model do, as a sorted list of strings. Compares
 * the effective switches, not the raw objects: the API fills in defaults on
 * the way back, and a spurious difference would retire a live session.
 */
const toolSignature = (tools: readonly ToolLike[] | undefined): string => {
  const parts: string[] = [];
  for (const tool of tools ?? []) {
    if (tool.type === "mcp_toolset") {
      parts.push(`mcp:${tool.mcp_server_name ?? ""}`);
    } else if (tool.type === "custom") {
      parts.push(`custom:${tool.name ?? ""}`);
    } else {
      const fallback = tool.default_config?.enabled ?? true;
      for (const name of BUILTIN_TOOLS) {
        const enabled =
          tool.configs?.find((config) => config.name === name)?.enabled ??
          fallback;
        parts.push(`builtin:${name}=${String(enabled)}`);
      }
    }
  }
  return parts.sort().join("|");
};

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

/**
 * Every agent is a coordinator: it can spawn copies of itself and, when one
 * exists, the shared cheap worker. Roster names must be unique and the `self`
 * entry is listed under the coordinator's own name, so an agent that happens
 * to share the worker's name goes without the worker rather than failing
 * validation.
 */
const multiagentFor = (name: string, workerAgentId: string | null) => ({
  agents: [
    { type: "self" as const },
    ...(workerAgentId && name !== WORKER_AGENT_NAME ? [workerAgentId] : []),
  ],
  type: "coordinator" as const,
});

const skillsFor = (skills: readonly AgentSkillRef[]) =>
  skills.map((skill) => ({
    skill_id: skill.skillId,
    type: "custom" as const,
    version: skill.version,
  }));

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

/**
 * Only the session-level idle event: `session.thread_status_idle` carries the
 * same field, and reading both would report every stop twice.
 */
const stopReasonOf = (
  event: BetaManagedAgentsSessionEvent
): string | undefined => {
  if (event.type !== "session.status_idle") {
    return;
  }
  // The SDK declares `stop_reason` required, but the wire is a beta's: treat
  // it as optional so an event without one stays a plain idle, not a crash.
  const reason: { type?: string } | undefined = event.stop_reason;
  return reason?.type;
};

/** The calls a `requires_action` idle is waiting on. */
const requiredEventIdsOf = (
  event: BetaManagedAgentsSessionEvent
): string[] | undefined => {
  if (event.type !== "session.status_idle") {
    return;
  }
  const reason: { event_ids?: string[]; type?: string } | undefined =
    event.stop_reason;
  return reason?.type === "requires_action"
    ? (reason.event_ids ?? [])
    : undefined;
};

const toSessionEvent = (
  event: BetaManagedAgentsSessionEvent
): SessionEvent => ({
  customToolName:
    event.type === "agent.custom_tool_use" ? event.name : undefined,
  id: event.id,
  processedAt: "processed_at" in event ? (event.processed_at ?? null) : null,
  requiredEventIds: requiredEventIdsOf(event),
  stopReason: stopReasonOf(event),
  text: textOf(event),
  type: event.type,
});

const TRANSCRIPT_TYPES = [
  "user.message",
  "agent.message",
  "agent.tool_use",
  "agent.mcp_tool_use",
  "agent.custom_tool_use",
  "agent.tool_result",
  "agent.mcp_tool_result",
  "user.custom_tool_result",
];
const INPUT_SUMMARY_MAX = 300;
const RESULT_MAX = 1000;
/** With the router's 25-entry pages this keeps a page near 40 KB. */
const MESSAGE_MAX = 1500;

const truncated = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}… [truncated]` : text;

const textBlocks = (
  content: readonly { text?: string; type: string }[] | undefined
): string =>
  (content ?? [])
    .flatMap((block) =>
      block.type === "text" && block.text ? [block.text] : []
    )
    .join("\n");

/** Text only: thinking, spans and status events never reach this. */
const toTranscriptEntry = (
  event: BetaManagedAgentsSessionEvent
): TranscriptEntry | undefined => {
  const at = "processed_at" in event ? (event.processed_at ?? null) : null;
  switch (event.type) {
    case "user.message":
      return {
        at,
        kind: "user",
        text: truncated(textBlocks(event.content), MESSAGE_MAX),
      };
    case "agent.message":
      return {
        at,
        kind: "agent",
        text: truncated(textBlocks(event.content), MESSAGE_MAX),
      };
    case "agent.tool_use":
    case "agent.mcp_tool_use":
    case "agent.custom_tool_use":
      return {
        at,
        kind: "tool_call",
        text: truncated(JSON.stringify(event.input), INPUT_SUMMARY_MAX),
        tool: event.name,
      };
    case "agent.tool_result":
    case "agent.mcp_tool_result":
    case "user.custom_tool_result":
      return {
        at,
        kind: "tool_result",
        text: truncated(textBlocks(event.content), RESULT_MAX),
      };
    default:
      return;
  }
};

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

  /**
   * The shared worker's agent id, created on first use. No look-before-create:
   * unlike environments, agents burn no concurrent slot, so a race merely
   * leaves an orphan the cache never points at again. Null when creation
   * fails - the caller rosters the agent without a worker rather than not at
   * all.
   */
  const ensureWorkerAgent = async (): Promise<string | null> => {
    const cached = await options.workerCache.read();
    if (cached) {
      return cached;
    }
    try {
      const worker = await client.beta.agents.create({
        description: WORKER_AGENT_DESCRIPTION,
        model: WORKER_AGENT_MODEL,
        name: WORKER_AGENT_NAME,
        system: WORKER_AGENT_SYSTEM,
        tools: toolsFor(undefined, []),
      });
      await options.workerCache.write(worker.id);
      return worker.id;
    } catch {
      return null;
    }
  };

  return {
    async createSession(input) {
      if (!input.anthropicAgentId) {
        throw new Error("The agent is not registered with Anthropic.");
      }
      const environmentId = await ensureEnvironment();
      const session = await client.beta.sessions.create({
        // Always sent, even when it matches the registration: omitted fields
        // are preserved, so this is the one application point that does not
        // depend on a best-effort sync having landed.
        agent: {
          id: input.anthropicAgentId,
          model: input.model,
          type: "agent_with_overrides",
        },
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

    async listSessionEvents(sessionId, paging) {
      // One page, not the `for await` drain: the cursor is the platform's own.
      const page = await client.beta.sessions.events.list(sessionId, {
        limit: paging.limit,
        order: "asc",
        ...(paging.cursor ? { page: paging.cursor } : {}),
        types: TRANSCRIPT_TYPES,
      });
      return {
        entries: page.data.flatMap((event) => {
          const entry = toTranscriptEntry(event);
          return entry ? [entry] : [];
        }),
        nextCursor: page.next_page,
      };
    },

    async listSessions(anthropicAgentId) {
      const found: ListedSession[] = [];
      for await (const session of client.beta.sessions.list({
        agent_id: anthropicAgentId,
        include_archived: true,
      })) {
        found.push({
          createdAt: session.created_at,
          id: session.id,
          title: session.title,
          updatedAt: session.updated_at,
        });
      }
      return found;
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
        model: input.model,
        multiagent: multiagentFor(input.name, await ensureWorkerAgent()),
        name: input.name,
        ...(input.skills && input.skills.length > 0
          ? { skills: skillsFor(input.skills) }
          : {}),
        system: input.system,
        tools: toolsFor(
          input.mcpUrl,
          input.connectors ?? [],
          input.computerOnly,
          input.desktop
        ),
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

    async sendCustomToolResult(sessionId, result) {
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            content: [
              { text: result.text, type: "text" },
              ...(result.image
                ? [
                    {
                      source: {
                        data: result.image.base64,
                        media_type: result.image.mediaType,
                        type: "base64" as const,
                      },
                      type: "image" as const,
                    },
                  ]
                : []),
            ],
            custom_tool_use_id: result.toolUseId,
            is_error: result.isError,
            type: "user.custom_tool_result",
          },
        ],
      });
    },

    async sendMessage(sessionId, text) {
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            content: [{ text, type: "text" }],
            type: "user.message",
          },
        ],
      });
    },

    async syncAgent(input) {
      // `tools` replaces the whole array, so a sync that does not carry the MCP
      // URL rebuilds it around the servers already registered. Any sync that
      // sends tools reads the registered ones first, to say whether they moved.
      const sendsTools = Boolean(input.mcpUrl) || input.computerOnly === true;
      const registered = sendsTools
        ? await client.beta.agents.retrieve(input.anthropicAgentId)
        : null;
      const desktop = input.desktop === true;
      const tools = input.mcpUrl
        ? toolsFor(
            input.mcpUrl,
            input.connectors ?? [],
            input.computerOnly,
            desktop
          )
        : registered && [
            agentToolset(true),
            ...registered.mcp_servers.map((server) => mcpToolset(server.name)),
            ...(desktop ? [desktopScreenshotTool] : []),
          ];

      // Omitted fields are preserved, so a roster-only resync leaves the agent's
      // MCP registration alone - which matters, because the plaintext token that
      // URL carries only exists when it is issued.
      await client.beta.agents.update(input.anthropicAgentId, {
        model: input.model,
        // Sent on every update, like the model: an agent registered before
        // subagents existed picks up its roster on the next resync.
        multiagent: multiagentFor(input.name, await ensureWorkerAgent()),
        name: input.name,
        system: input.system,
        ...(input.mcpUrl
          ? { mcp_servers: mcpServersFor(input.mcpUrl, input.connectors ?? []) }
          : {}),
        ...(tools ? { tools } : {}),
      });
      return {
        toolsChanged:
          Boolean(tools) &&
          toolSignature(tools ?? []) !== toolSignature(registered?.tools),
      };
    },

    async syncAgentSkills(input) {
      // Deliberately the whole payload: skills and nothing else. Omitted fields
      // are preserved (verified by the spike, both directions), so this leaves
      // `mcp_servers`, `tools` and the system prompt exactly as they are.
      await client.beta.agents.update(input.anthropicAgentId, {
        skills: skillsFor(input.skills),
      });
    },
  };
};
