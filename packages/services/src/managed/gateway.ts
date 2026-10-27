import Anthropic from "@anthropic-ai/sdk";
import type { BetaManagedAgentsSessionEvent } from "@anthropic-ai/sdk/resources/beta/sessions/events";
import { ASK_USER_TOOL, REQUEST_TAKEOVER_TOOL } from "@repo/protocol/requests";
import {
  AGENT_TOOL_NAMES,
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

/** A picture for a tool result. `data` is base64, without a data: prefix. */
export interface ToolResultImage {
  data: string;
  mediaType: string;
}

/**
 * Declared when the agent's computer has a desktop. Managed Agents ignore image
 * blocks in MCP results, so the picture comes back through this custom tool.
 */
export const DESKTOP_SCREENSHOT_TOOL = {
  description:
    "Take a screenshot of the computer's desktop. The picture comes back in the tool result.",
  inputSchema: { additionalProperties: false, properties: {}, type: "object" },
  name: "desktop_screenshot",
} as const;

export interface PolledEvents {
  cursor: EventCursor | undefined;
  events: SessionEvent[];
}

export interface ManagedGateway {
  /** Answers a `requires_action` tool confirmation: allow the call, or deny it with a reason. */
  confirmTool: (
    sessionId: string,
    toolUseId: string,
    decision: "allow" | "deny",
    denyMessage?: string
  ) => Promise<void>;
  /** A static_bearer credential for one MCP server URL. Header substitution only. */
  createBearerCredential: (input: {
    displayName: string;
    mcpServerUrl: string;
    token: string;
    vaultId: string;
  }) => Promise<string>;
  /**
   * An environment variable credential: the sandbox sees `$name` as a placeholder,
   * and the real value goes into requests to `hosts`. No `hosts` means any host, in
   * the header and the body.
   */
  createEnvironmentVariableCredential: (input: {
    hosts?: readonly string[];
    name: string;
    value: string;
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
    /** Tool keys whose rule is "ask": `<tool>` for a built-in, `<server>/<tool>` for an MCP tool. */
    askKeys: readonly string[];
    /** The agent's computer reports a desktop, so it gets the screenshot and takeover tools. */
    desktop?: boolean;
    instructions: string;
    mcpServers: readonly McpServerRef[];
    model: string;
    name: string;
    skills: readonly SkillRef[];
    system: string;
  }) => Promise<{ anthropicAgentId: string }>;
  /** Returns a picture as the result of a custom tool call. Managed Agents ignore MCP images, so this is the way one reaches the model. */
  sendCustomToolImageResult: (
    sessionId: string,
    toolUseId: string,
    image: ToolResultImage
  ) => Promise<void>;
  /** Returns the text of a custom tool call the session is waiting on. */
  sendCustomToolResult: (
    sessionId: string,
    toolUseId: string,
    text: string
  ) => Promise<void>;
  sendMessage: (sessionId: string, text: string) => Promise<void>;
  /** Replaces model, name, system, mcp_servers, skills and tools. Omitted fields stay. */
  syncAgent: (input: {
    anthropicAgentId: string;
    /** Tool keys whose rule is "ask": `<tool>` for a built-in, `<server>/<tool>` for an MCP tool. */
    askKeys: readonly string[];
    /** The agent's computer reports a desktop, so it gets the screenshot and takeover tools. */
    desktop?: boolean;
    mcpServers: readonly McpServerRef[];
    model: string;
    name: string;
    skills: readonly SkillRef[];
    system: string;
  }) => Promise<void>;
}

const CONFLICT = 409;
const DESCRIPTION_MAX_LENGTH = 2048;

/** Ordinary sessions retain explicit defaults. Artifact sessions pass the
 * wildcard and keep all native/MCP calls behind provider confirmations, even
 * if a guest joins after the remote session was configured. */
const permissive = {
  enabled: true,
  permission_policy: { type: "always_allow" as const },
};

/** The `configs` of a toolset: one `always_ask` entry per tool named. Omitted when none is. */
const configsFor = <Name extends string>(toolNames: readonly Name[]) =>
  toolNames.length > 0
    ? {
        configs: toolNames.map((name) => ({
          name,
          permission_policy: { type: "always_ask" as const },
        })),
      }
    : {};

const mcpToolset = (
  name: string,
  askNames: readonly string[],
  force = false
) => ({
  default_config: force
    ? { enabled: true, permission_policy: { type: "always_ask" as const } }
    : permissive,
  mcp_server_name: name,
  ...configsFor(askNames),
  type: "mcp_toolset" as const,
});

const agentToolset = (askNames: readonly AgentToolName[], force = false) => ({
  default_config: force
    ? { enabled: true, permission_policy: { type: "always_ask" as const } }
    : permissive,
  ...configsFor(askNames),
  type: AGENT_TOOLSET as "agent_toolset_20260401",
});

type AgentToolName = (typeof AGENT_TOOL_NAMES)[number];

const isAgentToolName = (key: string): key is AgentToolName =>
  AGENT_TOOL_NAMES.some((name) => name === key);

/**
 * Splits the ask keys by the toolset they belong to. A key with no "/" is a
 * built-in tool; `<server>/<tool>` is a tool on a declared server. Anything else
 * names nothing this agent has, and is dropped.
 */
const askNamesFor = (
  mcpServers: readonly McpServerRef[],
  askKeys: readonly string[]
) => {
  const agent: AgentToolName[] = [];
  const servers = new Map<string, string[]>(
    mcpServers.map((server) => [server.name, []])
  );
  for (const key of askKeys) {
    const slash = key.indexOf("/");
    if (slash === -1) {
      if (isAgentToolName(key)) {
        agent.push(key);
      }
    } else {
      servers.get(key.slice(0, slash))?.push(key.slice(slash + 1));
    }
  }
  return { agent, servers };
};

/** A custom tool as the API takes it. */
const customTool = ({
  description,
  inputSchema: { required, ...schema },
  name,
}: {
  description: string;
  inputSchema: {
    properties: Record<string, unknown>;
    required?: readonly string[];
    type: "object";
  };
  name: string;
}) => ({
  description,
  input_schema: {
    ...structuredClone(schema),
    // The screenshot tool takes no input, so it sends no `required`.
    ...(required ? { required: [...required] } : {}),
  },
  name,
  type: "custom" as const,
});

/**
 * Every declared server must be referenced by an `mcp_toolset`, so the toolsets
 * are built from the same list. The custom tools come last. `ask_user` is how
 * the agent asks a person a question, and nothing else carries that. An agent
 * whose computer has a desktop also gets `desktop_screenshot` and
 * `request_human_takeover`, because a picture and a wait both need a custom tool.
 */
const toolsFor = (
  mcpServers: readonly McpServerRef[],
  askKeys: readonly string[],
  desktop: boolean
) => {
  const asks = askNamesFor(mcpServers, askKeys);
  return [
    agentToolset(asks.agent, askKeys.includes("*")),
    ...mcpServers.map((server) =>
      mcpToolset(
        server.name,
        asks.servers.get(server.name) ?? [],
        askKeys.includes("*")
      )
    ),
    customTool(ASK_USER_TOOL),
    ...(desktop
      ? [customTool(DESKTOP_SCREENSHOT_TOOL), customTool(REQUEST_TAKEOVER_TOOL)]
      : []),
  ];
};

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
  if (event.type === "agent.mcp_tool_use") {
    return {
      id: event.id,
      input: event.input,
      name: event.name,
      server: event.mcp_server_name,
    };
  }
  if (
    event.type === "agent.tool_use" ||
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
    async confirmTool(sessionId, toolUseId, decision, denyMessage) {
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            ...(decision === "deny" && denyMessage
              ? { deny_message: denyMessage }
              : {}),
            result: decision,
            tool_use_id: toolUseId,
            type: "user.tool_confirmation",
          },
        ],
      });
    },

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

    async createEnvironmentVariableCredential(input) {
      const { hosts } = input;
      const credential = await client.beta.vaults.credentials.create(
        input.vaultId,
        {
          auth: {
            injection_location: { body: hosts === undefined, header: true },
            networking:
              hosts === undefined
                ? { type: "unrestricted" }
                : { allowed_hosts: [...hosts], type: "limited" },
            secret_name: input.name,
            secret_value: input.value,
            type: "environment_variable",
          },
          display_name: input.name,
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
        tools: toolsFor(
          input.mcpServers,
          input.askKeys,
          input.desktop === true
        ),
      });

      return { anthropicAgentId: agent.id };
    },

    async sendCustomToolImageResult(sessionId, toolUseId, image) {
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            content: [
              {
                source: {
                  data: image.data,
                  media_type: image.mediaType,
                  type: "base64",
                },
                type: "image",
              },
            ],
            custom_tool_use_id: toolUseId,
            type: "user.custom_tool_result",
          },
        ],
      });
    },

    async sendCustomToolResult(sessionId, toolUseId, text) {
      await client.beta.sessions.events.send(sessionId, {
        events: [
          {
            content: [{ text, type: "text" }],
            custom_tool_use_id: toolUseId,
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
        tools: toolsFor(
          input.mcpServers,
          input.askKeys,
          input.desktop === true
        ),
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
