import Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import {
  AGENT_TOOLSET,
  SESSION_BUDGET_CENTS,
  SESSION_BUDGET_CURRENCY,
} from "./config.ts";
import {
  advanceCursor,
  type EventCursor,
  eventsAfter,
  type SessionEvent,
  type SessionStatus,
} from "./events.ts";

/**
 * The whole Managed Agents surface we depend on, behind one interface. Nothing
 * outside this module imports `@anthropic-ai/sdk`: the API is in beta, so when
 * it changes, this file changes and the caller does not.
 */

/** One MCP server an agent connects to. */
export interface McpServerRef {
  name: string;
  url: string;
}

/** A custom skill an agent loads, pinned to one of its versions. */
export interface SkillRef {
  skillId: string;
  version: string;
}

/** One file of a skill. `path` is relative to the skill root, e.g. "scripts/hello.ts". */
export interface SkillUploadFile {
  content: Uint8Array;
  path: string;
}

/** Where an Anthropic-side id is remembered between requests. */
export interface IdCache {
  read: () => Promise<string | null>;
  write: (id: string) => Promise<void>;
}

export interface GatewayOptions {
  cache: IdCache;
  environmentName: string;
}

export interface CreatedSession {
  sessionId: string;
  status: SessionStatus;
}

export interface PolledEvents {
  cursor: EventCursor | undefined;
  events: SessionEvent[];
}

export interface ManagedGateway {
  /** A static_bearer credential for one MCP server URL. Header substitution only. */
  createBearerCredential: (input: {
    displayName: string;
    mcpServerUrl: string;
    token: string;
    vaultId: string;
  }) => Promise<string>;
  /** Sends `text` as the first message, under the budget. `vaultIds` hold the MCP credentials. */
  createSession: (input: {
    anthropicAgentId: string;
    model: string;
    text: string;
    title: string;
    vaultIds: readonly string[];
  }) => Promise<CreatedSession>;
  createSkill: (input: {
    displayTitle: string;
    files: readonly SkillUploadFile[];
    name: string;
  }) => Promise<{ skillId: string; version: string }>;
  /** A new version of an existing skill. `name` must equal the SKILL.md frontmatter name. */
  createSkillVersion: (input: {
    files: readonly SkillUploadFile[];
    name: string;
    skillId: string;
  }) => Promise<string>;
  createVault: (input: { displayName: string }) => Promise<string>;
  /** Deletes every version first, because the API refuses to delete a skill that has one. */
  deleteSkill: (skillId: string) => Promise<void>;
  deleteVault: (vaultId: string) => Promise<void>;
  ensureEnvironment: () => Promise<string>;
  getSession: (sessionId: string) => Promise<SessionStatus>;
  /** Sends a user.interrupt event. */
  interrupt: (sessionId: string) => Promise<void>;
  pollEvents: (
    sessionId: string,
    cursor: EventCursor | undefined
  ) => Promise<PolledEvents>;
  registerAgent: (input: {
    instructions: string;
    mcpServers: readonly McpServerRef[];
    model: string;
    name: string;
    skills: readonly SkillRef[];
    system: string;
  }) => Promise<{ anthropicAgentId: string }>;
  sendMessage: (sessionId: string, text: string) => Promise<void>;
  /** Replaces model, name, system, mcp_servers, skills and tools. Omitted fields stay. */
  syncAgent: (input: {
    anthropicAgentId: string;
    mcpServers: readonly McpServerRef[];
    model: string;
    name: string;
    skills: readonly SkillRef[];
    system: string;
  }) => Promise<void>;
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

const agentToolset = () => ({
  default_config: permissive,
  type: AGENT_TOOLSET as "agent_toolset_20260401",
});

/**
 * Every declared server must be referenced by an `mcp_toolset`, so the two
 * arrays are built from the same list.
 */
const toolsFor = (mcpServers: readonly McpServerRef[]) => [
  agentToolset(),
  ...mcpServers.map((server) => mcpToolset(server.name)),
];

/** `mcp_servers` is a full replacement, so it is sent whole or not at all. */
const mcpServersFor = (mcpServers: readonly McpServerRef[]) =>
  mcpServers.map((server) => ({
    name: server.name,
    type: "url" as const,
    url: server.url,
  }));

/**
 * Every upload's files sit under the skill name, which is the one directory the
 * API accepts. The directory layout travels in the file name.
 */
const skillFilesFor = (
  name: string,
  files: readonly SkillUploadFile[]
): File[] =>
  files.map(
    (file) =>
      new File([new Uint8Array(file.content)], `${name}/${file.path}`, {
        type: file.path.endsWith(".md")
          ? "text/markdown"
          : "application/octet-stream",
      })
  );

const skillsFor = (skills: readonly SkillRef[]) =>
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

const resultText = (
  content: readonly { text?: string; type: string }[] | undefined
): string =>
  (content ?? [])
    .map((block) =>
      block.type === "text" ? (block.text ?? "") : `[${block.type}]`
    )
    .join("\n");

/** The call an event makes, for the run's transcript. */
const toolOf = (
  event: BetaManagedAgentsSessionEvent
): SessionEvent["tool"] | undefined => {
  if (
    event.type === "agent.tool_use" ||
    event.type === "agent.mcp_tool_use" ||
    event.type === "agent.custom_tool_use"
  ) {
    return { id: event.id, input: event.input, name: event.name };
  }
};

/** The result an event carries, for the run's transcript. */
const resultOf = (
  event: BetaManagedAgentsSessionEvent
): SessionEvent["result"] | undefined => {
  if (event.type === "agent.tool_result") {
    return {
      isError: event.is_error === true,
      text: resultText(event.content),
      toolUseId: event.tool_use_id,
    };
  }
  if (event.type === "agent.mcp_tool_result") {
    return {
      isError: event.is_error === true,
      text: resultText(event.content),
      toolUseId: event.mcp_tool_use_id,
    };
  }
};

const toSessionEvent = (
  event: BetaManagedAgentsSessionEvent
): SessionEvent => ({
  customToolName:
    event.type === "agent.custom_tool_use" ? event.name : undefined,
  id: event.id,
  processedAt: "processed_at" in event ? (event.processed_at ?? null) : null,
  requiredEventIds: requiredEventIdsOf(event),
  result: resultOf(event),
  stopReason: stopReasonOf(event),
  text: textOf(event),
  tool: toolOf(event),
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

export const createManagedGateway = (
  client: Anthropic,
  options: GatewayOptions
): ManagedGateway => {
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
    async createBearerCredential(input) {
      const credential = await client.beta.vaults.credentials.create(
        input.vaultId,
        {
          auth: {
            mcp_server_url: input.mcpServerUrl,
            token: input.token,
            type: "static_bearer",
          },
          display_name: input.displayName,
        }
      );
      return credential.id;
    },

    async createSession(input) {
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
        ...(input.vaultIds.length > 0
          ? { vault_ids: [...input.vaultIds] }
          : {}),
        title: input.title,
      });
      return { sessionId: session.id, status: statusOf(session.status) };
    },

    async createSkill(input) {
      const skill = await client.beta.skills.create({
        display_title: input.displayTitle,
        files: skillFilesFor(input.name, input.files),
      });
      if (!skill.latest_version) {
        throw new Error(`Anthropic created skill ${skill.id} with no version`);
      }
      return { skillId: skill.id, version: skill.latest_version };
    },

    async createSkillVersion(input) {
      // No display title here: it lives on the skill. A version carries files only.
      const version = await client.beta.skills.versions.create(input.skillId, {
        files: skillFilesFor(input.name, input.files),
      });
      return version.version;
    },

    async createVault(input) {
      const vault = await client.beta.vaults.create({
        display_name: input.displayName,
      });
      return vault.id;
    },

    async deleteSkill(skillId) {
      // Collected before deleting, so the pages are not read while they shrink.
      const versions: string[] = [];
      for await (const version of client.beta.skills.versions.list(skillId)) {
        versions.push(version.version);
      }
      // One at a time: deleting versions concurrently left a skill that no
      // longer listed a version but could not be deleted (verified 2026-10-17).
      for (const version of versions) {
        // biome-ignore lint/performance/noAwaitInLoops: concurrent deletes strand the skill
        await client.beta.skills.versions.delete(version, {
          skill_id: skillId,
        });
      }
      await client.beta.skills.delete(skillId);
    },

    async deleteVault(vaultId) {
      await client.beta.vaults.delete(vaultId);
    },

    ensureEnvironment,

    async getSession(sessionId) {
      const session = await client.beta.sessions.retrieve(sessionId);
      return statusOf(session.status);
    },

    async interrupt(sessionId) {
      await client.beta.sessions.events.send(sessionId, {
        events: [{ type: "user.interrupt" }],
      });
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
      const agent = await client.beta.agents.create({
        description:
          input.instructions.slice(0, DESCRIPTION_MAX_LENGTH) || undefined,
        ...(input.mcpServers.length > 0
          ? { mcp_servers: mcpServersFor(input.mcpServers) }
          : {}),
        model: input.model,
        name: input.name,
        ...(input.skills.length > 0 ? { skills: skillsFor(input.skills) } : {}),
        system: input.system,
        tools: toolsFor(input.mcpServers),
      });

      return { anthropicAgentId: agent.id };
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
      // `tools` and `skills` replace their whole arrays, so both are always
      // sent, even empty: an empty `skills` detaches every skill.
      await client.beta.agents.update(input.anthropicAgentId, {
        model: input.model,
        name: input.name,
        skills: skillsFor(input.skills),
        system: input.system,
        ...(input.mcpServers.length > 0
          ? { mcp_servers: mcpServersFor(input.mcpServers) }
          : {}),
        tools: toolsFor(input.mcpServers),
      });
    },
  };
};

/**
 * Whether Anthropic accepts a key, by the cheapest authenticated call there
 * is. Fail closed: anything but a clean answer is a no, and the reason is
 * dropped because an SDK error can quote the request it was made with.
 */
export const validateAnthropicKey = async (
  apiKey: string
): Promise<boolean> => {
  try {
    await new Anthropic({ apiKey }).models.list({ limit: 1 });
    return true;
  } catch {
    return false;
  }
};

/** The gateway over a real API key. Tests build `createManagedGateway` on a fake client instead. */
export const connectManagedGateway = (
  apiKey: string,
  options: GatewayOptions
): ManagedGateway => createManagedGateway(new Anthropic({ apiKey }), options);
