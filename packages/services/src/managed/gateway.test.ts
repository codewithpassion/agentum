import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ASK_USER_TOOL } from "@repo/protocol/requests";
import { AGENT_MODEL, modelFor } from "./config.ts";
import { createManagedGateway, type IdCache } from "./gateway.ts";

/**
 * The SDK is faked down to the handful of calls the gateway makes. Casting the
 * fake is confined to `client()`, so the tests themselves stay typed.
 */

interface FakeEnvironment {
  archived_at: string | null;
  id: string;
  name: string;
}

/** The SDK returns auto-paginating async iterators; this is the shape of one. */
const iterate = async function* <T>(items: readonly T[]) {
  await Promise.resolve();
  yield* items;
};

const client = (parts: Record<string, unknown>): Anthropic =>
  ({ beta: parts }) as unknown as Anthropic;

const memoryCache = (
  value: string | null = null
): IdCache & { value: string | null } => ({
  read() {
    return Promise.resolve(this.value);
  },
  value,
  write(id: string) {
    this.value = id;
    return Promise.resolve();
  },
});

const MCP_SERVERS = [
  { name: "harbourmaster", url: "https://app.example.com/mcp" },
  { name: "connector_aaaa", url: "https://a.example.com/mcp" },
];

const ALWAYS_ALLOW = {
  enabled: true,
  permission_policy: { type: "always_allow" },
};

const ASK_USER_CUSTOM_TOOL = {
  description: ASK_USER_TOOL.description,
  input_schema: ASK_USER_TOOL.inputSchema,
  name: ASK_USER_TOOL.name,
  type: "custom",
};

describe("ensureEnvironment", () => {
  const environments = (
    existing: FakeEnvironment[],
    created: { calls: number }
  ) => ({
    environments: {
      create: () => {
        created.calls += 1;
        return Promise.resolve({ id: "env_new" });
      },
      list: () => iterate(existing),
    },
  });

  test("adopts an existing environment of the same name", async () => {
    const created = { calls: 0 };
    const gateway = createManagedGateway(
      client(
        environments(
          [{ archived_at: null, id: "env_existing", name: "harbourmaster" }],
          created
        )
      ),
      { cache: memoryCache(), environmentName: "harbourmaster" }
    );

    expect(await gateway.ensureEnvironment()).toBe("env_existing");
    // Creating a second one would burn a concurrent-environment slot: the live
    // API does not reject duplicate names, so this look-up is the only guard.
    expect(created.calls).toBe(0);
  });

  test("skips an archived environment and creates a fresh one", async () => {
    const created = { calls: 0 };
    const gateway = createManagedGateway(
      client(
        environments(
          [
            {
              archived_at: "2026-08-01T00:00:00Z",
              id: "env_old",
              name: "harbourmaster",
            },
          ],
          created
        )
      ),
      { cache: memoryCache(), environmentName: "harbourmaster" }
    );

    expect(await gateway.ensureEnvironment()).toBe("env_new");
    expect(created.calls).toBe(1);
  });

  test("caches the id, so the second call makes no request", async () => {
    const created = { calls: 0 };
    const cache = memoryCache();
    let lists = 0;
    const gateway = createManagedGateway(
      client({
        environments: {
          create: () => {
            created.calls += 1;
            return Promise.resolve({ id: "env_new" });
          },
          list: () => {
            lists += 1;
            return iterate<FakeEnvironment>([]);
          },
        },
      }),
      { cache, environmentName: "harbourmaster" }
    );

    await gateway.ensureEnvironment();
    await gateway.ensureEnvironment();

    expect(lists).toBe(1);
    expect(created.calls).toBe(1);
    expect(cache.value).toBe("env_new");
  });
});

describe("syncAgent", () => {
  const updates: Record<string, unknown>[] = [];
  const gateway = createManagedGateway(
    client({
      agents: {
        update: (_id: string, body: Record<string, unknown>) => {
          updates.push(body);
          return Promise.resolve({});
        },
      },
    }),
    { cache: memoryCache(), environmentName: "harbourmaster" }
  );

  const lastUpdate = () => updates.at(-1) ?? {};

  test("declares every server in the array, in order", async () => {
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      askKeys: [],
      mcpServers: MCP_SERVERS,
      model: AGENT_MODEL,
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    expect(lastUpdate().mcp_servers).toEqual([
      {
        name: "harbourmaster",
        type: "url",
        url: "https://app.example.com/mcp",
      },
      {
        name: "connector_aaaa",
        type: "url",
        url: "https://a.example.com/mcp",
      },
    ]);
  });

  test("gives every declared server a matching always-allow toolset", async () => {
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      askKeys: [],
      mcpServers: MCP_SERVERS,
      model: AGENT_MODEL,
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    // The API requires a toolset per server, and a bare `mcp_toolset` comes
    // back as `always_ask` - which would park the session waiting for a human.
    expect(lastUpdate().tools).toEqual([
      {
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        type: "agent_toolset_20260401",
      },
      {
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        mcp_server_name: "harbourmaster",
        type: "mcp_toolset",
      },
      {
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        mcp_server_name: "connector_aaaa",
        type: "mcp_toolset",
      },
      ASK_USER_CUSTOM_TOOL,
    ]);
  });

  test("sends the model it was handed, not the workspace default", async () => {
    // Every update carries the model, so a roster resync that used the constant
    // would quietly put a re-modelled agent back on Sonnet.
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      askKeys: [],
      mcpServers: [],
      model: "claude-opus-5-5",
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    expect(lastUpdate().model).toBe("claude-opus-5-5");
  });

  test("sends only the agent toolset and no mcp_servers when the array is empty", async () => {
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      askKeys: [],
      mcpServers: [],
      model: AGENT_MODEL,
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    expect(lastUpdate()).not.toHaveProperty("mcp_servers");
    expect(lastUpdate().tools).toEqual([
      {
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        type: "agent_toolset_20260401",
      },
      ASK_USER_CUSTOM_TOOL,
    ]);
  });
});

describe("registerAgent", () => {
  const created: Record<string, unknown>[] = [];
  const gateway = createManagedGateway(
    client({
      agents: {
        create: (body: Record<string, unknown>) => {
          created.push(body);
          return Promise.resolve({ id: "agt_1" });
        },
      },
    }),
    { cache: memoryCache(), environmentName: "harbourmaster" }
  );

  test("registers the agent on the model it was handed", async () => {
    const result = await gateway.registerAgent({
      askKeys: [],
      instructions: "be helpful",
      mcpServers: [],
      model: "claude-haiku-5-5",
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    expect(result).toEqual({ anthropicAgentId: "agt_1" });
    expect(created.at(-1)?.model).toBe("claude-haiku-5-5");
  });

  test("declares each MCP server and one always-allow toolset per server", async () => {
    await gateway.registerAgent({
      askKeys: [],
      instructions: "be helpful",
      mcpServers: MCP_SERVERS,
      model: AGENT_MODEL,
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    const body = created.at(-1);
    expect(body?.mcp_servers).toEqual([
      {
        name: "harbourmaster",
        type: "url",
        url: "https://app.example.com/mcp",
      },
      {
        name: "connector_aaaa",
        type: "url",
        url: "https://a.example.com/mcp",
      },
    ]);
    const tools = body?.tools as { mcp_server_name?: string; type: string }[];
    const toolsets = tools
      .filter((tool) => tool.type === "mcp_toolset")
      .map((tool) => tool.mcp_server_name);
    expect(toolsets).toEqual(["harbourmaster", "connector_aaaa"]);
    expect(body?.tools).toContainEqual({
      default_config: {
        enabled: true,
        permission_policy: { type: "always_allow" },
      },
      mcp_server_name: "connector_aaaa",
      type: "mcp_toolset",
    });
  });

  test("sends no mcp_servers and only the agent toolset without servers", async () => {
    await gateway.registerAgent({
      askKeys: [],
      instructions: "be helpful",
      mcpServers: [],
      model: AGENT_MODEL,
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    expect(created.at(-1)).not.toHaveProperty("mcp_servers");
    expect(created.at(-1)?.tools).toEqual([
      {
        default_config: {
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        type: "agent_toolset_20260401",
      },
      ASK_USER_CUSTOM_TOOL,
    ]);
  });
});

describe("createSession", () => {
  const created: Record<string, unknown>[] = [];
  const gateway = createManagedGateway(
    client({
      environments: {
        list: () =>
          iterate([{ archived_at: null, id: "env_1", name: "harbourmaster" }]),
      },
      sessions: {
        create: (body: Record<string, unknown>) => {
          created.push(body);
          return Promise.resolve({ id: "sesn_1", status: "running" });
        },
      },
    }),
    { cache: memoryCache(), environmentName: "harbourmaster" }
  );

  const session = {
    anthropicAgentId: "agt_1",
    model: AGENT_MODEL,
    text: "hello",
    title: "Ada in ch_1",
  };

  test("attaches the vaults holding the MCP credentials", async () => {
    await gateway.createSession({
      ...session,
      vaultIds: ["vault_a", "vault_b"],
    });

    expect(created.at(-1)?.vault_ids).toEqual(["vault_a", "vault_b"]);
  });

  test("omits the field when there are no vaults", async () => {
    await gateway.createSession({ ...session, vaultIds: [] });

    expect(created.at(-1)).not.toHaveProperty("vault_ids");
  });

  test("runs the session on the model it was handed", async () => {
    // The per-session override is the load-bearing application point: it needs
    // no registration sync to have landed, and omitted fields are preserved.
    await gateway.createSession({
      ...session,
      model: "claude-opus-5-5",
      vaultIds: [],
    });

    expect(created.at(-1)?.agent).toEqual({
      id: "agt_1",
      model: "claude-opus-5-5",
      type: "agent_with_overrides",
    });
  });

  test("caps the session at the budget", async () => {
    await gateway.createSession({ ...session, vaultIds: [] });

    expect(created.at(-1)?.budget).toEqual({
      max_list_cost: { amount: "1000", currency: "USD" },
      type: "limit",
    });
  });
});

describe("createVault", () => {
  test("sends only the display name", async () => {
    const created: Record<string, unknown>[] = [];
    const gateway = createManagedGateway(
      client({
        vaults: {
          create: (body: Record<string, unknown>) => {
            created.push(body);
            return Promise.resolve({ id: "vlt_1" });
          },
        },
      }),
      { cache: memoryCache(), environmentName: "harbourmaster" }
    );

    expect(await gateway.createVault({ displayName: "Ada" })).toBe("vlt_1");
    expect(created).toEqual([{ display_name: "Ada" }]);
  });
});

describe("createBearerCredential", () => {
  test("stores a static bearer for one MCP server URL in the vault", async () => {
    const calls: { body: Record<string, unknown>; vaultId: string }[] = [];
    const gateway = createManagedGateway(
      client({
        vaults: {
          credentials: {
            create: (vaultId: string, body: Record<string, unknown>) => {
              calls.push({ body, vaultId });
              return Promise.resolve({ id: "vcrd_1" });
            },
          },
        },
      }),
      { cache: memoryCache(), environmentName: "harbourmaster" }
    );

    const id = await gateway.createBearerCredential({
      displayName: "Ada connector",
      mcpServerUrl: "https://a.example.com/mcp",
      token: "test-token-not-real",
      vaultId: "vlt_1",
    });

    expect(id).toBe("vcrd_1");
    expect(calls).toEqual([
      {
        body: {
          auth: {
            mcp_server_url: "https://a.example.com/mcp",
            token: "test-token-not-real",
            type: "static_bearer",
          },
          display_name: "Ada connector",
        },
        vaultId: "vlt_1",
      },
    ]);
  });
});

describe("deleteVault", () => {
  test("deletes the vault by id", async () => {
    const deleted: string[] = [];
    const gateway = createManagedGateway(
      client({
        vaults: {
          delete: (vaultId: string) => {
            deleted.push(vaultId);
            return Promise.resolve({});
          },
        },
      }),
      { cache: memoryCache(), environmentName: "harbourmaster" }
    );

    await gateway.deleteVault("vlt_1");

    expect(deleted).toEqual(["vlt_1"]);
  });
});

describe("interrupt", () => {
  test("sends a user.interrupt event with no other fields", async () => {
    const sent: { events: unknown[]; sessionId: string }[] = [];
    const gateway = createManagedGateway(
      client({
        sessions: {
          events: {
            send: (sessionId: string, body: { events: unknown[] }) => {
              sent.push({ events: body.events, sessionId });
              return Promise.resolve({});
            },
          },
        },
      }),
      { cache: memoryCache(), environmentName: "harbourmaster" }
    );

    await gateway.interrupt("sesn_1");

    expect(sent).toEqual([
      { events: [{ type: "user.interrupt" }], sessionId: "sesn_1" },
    ]);
  });
});

describe("pollEvents", () => {
  const eventsClient = (pages: Record<string, unknown[]>, seen: string[]) => ({
    sessions: {
      events: {
        list: (_sessionId: string, params: Record<string, unknown>) => {
          const key = String(params["created_at[gte]"] ?? "start");
          seen.push(key);
          return iterate(pages[key] ?? []);
        },
      },
    },
  });

  const gatewayFor = (pages: Record<string, unknown[]>, seen: string[]) =>
    createManagedGateway(client(eventsClient(pages, seen)), {
      cache: memoryCache(),
      environmentName: "harbourmaster",
    });

  test("flattens agent text and returns a cursor at the last event", async () => {
    const seen: string[] = [];
    const gateway = gatewayFor(
      {
        start: [
          {
            content: [
              { text: "po", type: "text" },
              { text: "ng", type: "text" },
            ],
            id: "evt_1",
            processed_at: "t1",
            type: "agent.message",
          },
          { id: "evt_2", processed_at: "t2", type: "session.status_idle" },
        ],
      },
      seen
    );

    const page = await gateway.pollEvents("sesn_1", undefined);

    expect(page.events[0]?.text).toBe("pong");
    expect(page.cursor).toEqual({
      lastEventId: "evt_2",
      lastProcessedAt: "t2",
    });
  });

  test("re-requests from the cursor timestamp and drops the overlap", async () => {
    const seen: string[] = [];
    const gateway = gatewayFor(
      {
        t2: [
          // The inclusive timestamp filter hands the cursor's event back.
          { id: "evt_2", processed_at: "t2", type: "session.status_running" },
          { id: "evt_3", processed_at: "t3", type: "session.status_idle" },
        ],
      },
      seen
    );

    const page = await gateway.pollEvents("sesn_1", {
      lastEventId: "evt_2",
      lastProcessedAt: "t2",
    });

    expect(seen).toEqual(["t2"]);
    expect(page.events.map((entry) => entry.id)).toEqual(["evt_3"]);
  });

  test("keeps the old cursor when nothing new arrived", async () => {
    const cursor = { lastEventId: "evt_2", lastProcessedAt: "t2" };
    const page = await gatewayFor({}, []).pollEvents("sesn_1", cursor);

    expect(page.events).toEqual([]);
    expect(page.cursor).toBe(cursor);
  });

  test("carries tool calls and their results, with non-text blocks named", async () => {
    const gateway = gatewayFor(
      {
        start: [
          {
            id: "evt_use",
            input: { text: "hi" },
            mcp_server_name: "harbourmaster",
            name: "echo",
            processed_at: "t1",
            type: "agent.mcp_tool_use",
          },
          {
            content: [
              { text: "hi", type: "text" },
              { source: {}, type: "image" },
            ],
            id: "evt_res",
            is_error: false,
            mcp_tool_use_id: "evt_use",
            processed_at: "t2",
            type: "agent.mcp_tool_result",
          },
          {
            content: [{ text: "denied", type: "text" }],
            id: "evt_res2",
            is_error: true,
            processed_at: "t3",
            tool_use_id: "evt_bash",
            type: "agent.tool_result",
          },
        ],
      },
      []
    );

    const { events } = await gateway.pollEvents("sesn_1", undefined);

    expect(events[0]?.tool).toEqual({
      id: "evt_use",
      input: { text: "hi" },
      name: "echo",
      server: "harbourmaster",
    });
    expect(events[1]?.result).toEqual({
      isError: false,
      text: "hi\n[image]",
      toolUseId: "evt_use",
    });
    expect(events[2]?.result).toEqual({
      isError: true,
      text: "denied",
      toolUseId: "evt_bash",
    });
  });

  test("names the MCP server on an MCP tool call, and no server on a built-in one", async () => {
    const gateway = gatewayFor(
      {
        start: [
          {
            id: "evt_mcp",
            input: { channel: "general" },
            mcp_server_name: "harbourmaster",
            name: "post_message",
            processed_at: "t1",
            type: "agent.mcp_tool_use",
          },
          {
            id: "evt_bash",
            input: { command: "ls" },
            name: "bash",
            processed_at: "t2",
            type: "agent.tool_use",
          },
        ],
      },
      []
    );

    const { events } = await gateway.pollEvents("sesn_1", undefined);

    expect(events[0]?.tool).toEqual({
      id: "evt_mcp",
      input: { channel: "general" },
      name: "post_message",
      server: "harbourmaster",
    });
    expect(events[1]?.tool).toEqual({
      id: "evt_bash",
      input: { command: "ls" },
      name: "bash",
    });
  });

  test("reads the message out of a session error", async () => {
    const gateway = gatewayFor(
      {
        start: [
          {
            error: { message: "model overloaded", type: "model_overloaded" },
            id: "evt_1",
            processed_at: "t1",
            type: "session.error",
          },
        ],
      },
      []
    );

    const page = await gateway.pollEvents("sesn_1", undefined);

    expect(page.events[0]?.text).toBe("model overloaded");
  });

  test("maps a custom tool call and the requires_action idle that waits on it", async () => {
    const gateway = createManagedGateway(
      client({
        sessions: {
          events: {
            list: () =>
              iterate([
                {
                  id: "evt_use",
                  input: {},
                  name: "post_message",
                  processed_at: "2026-10-13T10:00:00Z",
                  type: "agent.custom_tool_use",
                },
                {
                  id: "evt_idle",
                  processed_at: "2026-10-13T10:00:01Z",
                  stop_reason: {
                    event_ids: ["evt_use"],
                    type: "requires_action",
                  },
                  type: "session.status_idle",
                },
              ]),
          },
        },
      }),
      { cache: memoryCache(), environmentName: "harbourmaster" }
    );

    const { events } = await gateway.pollEvents("sesn_1", undefined);

    expect(events[0]).toMatchObject({
      customToolName: "post_message",
      id: "evt_use",
      type: "agent.custom_tool_use",
    });
    expect(events[1]).toMatchObject({
      requiredEventIds: ["evt_use"],
      stopReason: "requires_action",
    });
  });
});

describe("tool confirmation rules", () => {
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const gateway = createManagedGateway(
    client({
      agents: {
        create: (body: Record<string, unknown>) => {
          created.push(body);
          return Promise.resolve({ id: "agt_1" });
        },
        update: (_id: string, body: Record<string, unknown>) => {
          updates.push(body);
          return Promise.resolve({});
        },
      },
    }),
    { cache: memoryCache(), environmentName: "harbourmaster" }
  );

  const ASK_KEYS = [
    "bash",
    "harbourmaster/post_message",
    "connector_aaaa/send",
    "nope/x",
    "run_script",
  ];

  test("puts each ask key on the toolset it belongs to, always_ask, and ignores the rest", async () => {
    await gateway.registerAgent({
      askKeys: ASK_KEYS,
      instructions: "be helpful",
      mcpServers: MCP_SERVERS,
      model: AGENT_MODEL,
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    expect(created.at(-1)?.tools).toEqual([
      {
        configs: [{ name: "bash", permission_policy: { type: "always_ask" } }],
        default_config: ALWAYS_ALLOW,
        type: "agent_toolset_20260401",
      },
      {
        configs: [
          { name: "post_message", permission_policy: { type: "always_ask" } },
        ],
        default_config: ALWAYS_ALLOW,
        mcp_server_name: "harbourmaster",
        type: "mcp_toolset",
      },
      {
        configs: [{ name: "send", permission_policy: { type: "always_ask" } }],
        default_config: ALWAYS_ALLOW,
        mcp_server_name: "connector_aaaa",
        type: "mcp_toolset",
      },
      ASK_USER_CUSTOM_TOOL,
    ]);
    const sent = JSON.stringify(created.at(-1)?.tools);
    expect(sent).not.toContain("nope");
    expect(sent).not.toContain("run_script");
  });

  test("syncAgent sends the same rules", async () => {
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      askKeys: ASK_KEYS,
      mcpServers: MCP_SERVERS,
      model: AGENT_MODEL,
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    expect(updates.at(-1)?.tools).toEqual(created.at(-1)?.tools);
  });

  test("a run with no ask keys sends no configs on any toolset", async () => {
    await gateway.registerAgent({
      askKeys: [],
      instructions: "be helpful",
      mcpServers: MCP_SERVERS,
      model: AGENT_MODEL,
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    const tools = created.at(-1)?.tools as Record<string, unknown>[];
    for (const tool of tools) {
      expect(tool).not.toHaveProperty("configs");
    }
  });
});

describe("confirmTool and sendCustomToolResult", () => {
  const sent: unknown[] = [];
  const gateway = createManagedGateway(
    client({
      sessions: {
        events: {
          send: (sessionId: string, params: unknown) => {
            sent.push({ params, sessionId });
            return Promise.resolve({});
          },
        },
      },
    }),
    { cache: memoryCache(), environmentName: "harbourmaster" }
  );

  test("confirmTool allows a call with no deny message", async () => {
    sent.length = 0;
    await gateway.confirmTool("sesn_1", "evt_use", "allow");

    expect(sent).toEqual([
      {
        params: {
          events: [
            {
              result: "allow",
              tool_use_id: "evt_use",
              type: "user.tool_confirmation",
            },
          ],
        },
        sessionId: "sesn_1",
      },
    ]);
  });

  test("confirmTool denies a call with the message", async () => {
    sent.length = 0;
    await gateway.confirmTool("sesn_1", "evt_use", "deny", "not today");

    expect(sent).toEqual([
      {
        params: {
          events: [
            {
              deny_message: "not today",
              result: "deny",
              tool_use_id: "evt_use",
              type: "user.tool_confirmation",
            },
          ],
        },
        sessionId: "sesn_1",
      },
    ]);
  });

  test("sendCustomToolResult sends the text as one text block", async () => {
    sent.length = 0;
    await gateway.sendCustomToolResult("sesn_1", "evt_use", "yes, blue");

    expect(sent).toEqual([
      {
        params: {
          events: [
            {
              content: [{ text: "yes, blue", type: "text" }],
              custom_tool_use_id: "evt_use",
              type: "user.custom_tool_result",
            },
          ],
        },
        sessionId: "sesn_1",
      },
    ]);
  });
});

describe("sendMessage", () => {
  const sendClient = (sent: unknown[]) => ({
    sessions: {
      events: {
        send: (sessionId: string, params: unknown) => {
          sent.push({ params, sessionId });
          return Promise.resolve({});
        },
      },
    },
  });

  const gatewayFor = (sent: unknown[]) =>
    createManagedGateway(client(sendClient(sent)), {
      cache: memoryCache(),
      environmentName: "harbourmaster",
    });

  test("sends plain text as one text block", async () => {
    const sent: unknown[] = [];
    await gatewayFor(sent).sendMessage("sesn_1", "hello");

    expect(sent).toEqual([
      {
        params: {
          events: [
            {
              content: [{ text: "hello", type: "text" }],
              type: "user.message",
            },
          ],
        },
        sessionId: "sesn_1",
      },
    ]);
  });
});

describe("agent skills", () => {
  const SKILLS = [{ skillId: "skill_1", version: "3" }];
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const gateway = createManagedGateway(
    client({
      agents: {
        create: (body: Record<string, unknown>) => {
          created.push(body);
          return Promise.resolve({ id: "agt_1" });
        },
        update: (_id: string, body: Record<string, unknown>) => {
          updates.push(body);
          return Promise.resolve({});
        },
      },
    }),
    { cache: memoryCache(), environmentName: "harbourmaster" }
  );

  test("registerAgent leaves skills out when there are none", async () => {
    await gateway.registerAgent({
      askKeys: [],
      instructions: "be helpful",
      mcpServers: [],
      model: AGENT_MODEL,
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    expect(created.at(-1)).not.toHaveProperty("skills");
  });

  test("registerAgent pins each skill to its version", async () => {
    await gateway.registerAgent({
      askKeys: [],
      instructions: "be helpful",
      mcpServers: [],
      model: AGENT_MODEL,
      name: "Ada",
      skills: SKILLS,
      system: "be helpful",
    });

    expect(created.at(-1)?.skills).toEqual([
      { skill_id: "skill_1", type: "custom", version: "3" },
    ]);
  });

  test("syncAgent always sends skills, so an empty array detaches them", async () => {
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      askKeys: [],
      mcpServers: [],
      model: AGENT_MODEL,
      name: "Ada",
      skills: [],
      system: "be helpful",
    });

    expect(updates.at(-1)).toHaveProperty("skills", []);
  });

  test("syncAgent pins each skill to its version", async () => {
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      askKeys: [],
      mcpServers: [],
      model: AGENT_MODEL,
      name: "Ada",
      skills: SKILLS,
      system: "be helpful",
    });

    expect(updates.at(-1)?.skills).toEqual([
      { skill_id: "skill_1", type: "custom", version: "3" },
    ]);
  });
});

describe("createSkill", () => {
  test("names every file under the skill name and keeps its path below it", async () => {
    const created: { display_title: string; files: File[] }[] = [];
    const gateway = createManagedGateway(
      client({
        skills: {
          create: (body: { display_title: string; files: File[] }) => {
            created.push(body);
            return Promise.resolve({ id: "skill_1", latest_version: "1" });
          },
        },
      }),
      { cache: memoryCache(), environmentName: "harbourmaster" }
    );

    const result = await gateway.createSkill({
      displayTitle: "Greeter",
      files: [
        {
          content: new TextEncoder().encode("---\nname: greeter\n---"),
          path: "SKILL.md",
        },
        {
          content: new TextEncoder().encode("console.log('hi')"),
          path: "scripts/hello.ts",
        },
      ],
      name: "greeter",
    });

    expect(result).toEqual({ skillId: "skill_1", version: "1" });
    expect(created.at(-1)?.display_title).toBe("Greeter");
    expect(created.at(-1)?.files.map((file) => [file.name, file.type])).toEqual(
      [
        ["greeter/SKILL.md", "text/markdown"],
        ["greeter/scripts/hello.ts", "application/octet-stream"],
      ]
    );
  });
});

describe("deleteSkill", () => {
  test("deletes every version before the skill itself", async () => {
    const log: string[] = [];
    const gateway = createManagedGateway(
      client({
        skills: {
          delete: (skillId: string) => {
            log.push(`skill:${skillId}`);
            return Promise.resolve({});
          },
          versions: {
            delete: (version: string, params: { skill_id: string }) => {
              log.push(`version:${params.skill_id}:${version}`);
              return Promise.resolve({});
            },
            list: (skillId: string) => {
              log.push(`list:${skillId}`);
              return iterate([{ version: "1" }, { version: "2" }]);
            },
          },
        },
      }),
      { cache: memoryCache(), environmentName: "harbourmaster" }
    );

    await gateway.deleteSkill("skill_1");

    expect(log).toEqual([
      "list:skill_1",
      "version:skill_1:1",
      "version:skill_1:2",
      "skill:skill_1",
    ]);
  });
});

describe("modelFor", () => {
  test("maps the short aliases to their catalog ids", () => {
    expect(modelFor("opus")).toBe("claude-opus-5-5");
    expect(modelFor("sonnet")).toBe("claude-sonnet-5-5");
    expect(modelFor("haiku")).toBe("claude-haiku-5-5");
  });

  test("ignores case and surrounding space on an alias", () => {
    expect(modelFor("  Opus ")).toBe("claude-opus-5-5");
  });

  test("passes a catalog id through", () => {
    expect(modelFor("claude-haiku-5-5")).toBe("claude-haiku-5-5");
  });

  test("falls back to the workspace default for anything else", () => {
    expect(modelFor("claude-unknown-9-9")).toBe(AGENT_MODEL);
    expect(modelFor("")).toBe(AGENT_MODEL);
    expect(modelFor("constructor")).toBe(AGENT_MODEL);
  });
});
