import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { AGENT_MODEL, WORKER_AGENT_MODEL, WORKER_AGENT_NAME } from "./config";
import { createAnthropicGateway, type IdCache } from "./gateway";

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

/** A worker already known, so no test trips over the lazy worker creation. */
const workerCache = () => memoryCache("agt_worker");

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
    const gateway = createAnthropicGateway(
      client(
        environments(
          [{ archived_at: null, id: "env_existing", name: "agentum" }],
          created
        )
      ),
      {
        cache: memoryCache(),
        environmentName: "agentum",
        workerCache: workerCache(),
      }
    );

    expect(await gateway.ensureEnvironment()).toBe("env_existing");
    // Creating a second one would burn a concurrent-environment slot: the live
    // API does not reject duplicate names, so this look-up is the only guard.
    expect(created.calls).toBe(0);
  });

  test("skips an archived environment and creates a fresh one", async () => {
    const created = { calls: 0 };
    const gateway = createAnthropicGateway(
      client(
        environments(
          [
            {
              archived_at: "2026-08-01T00:00:00Z",
              id: "env_old",
              name: "agentum",
            },
          ],
          created
        )
      ),
      {
        cache: memoryCache(),
        environmentName: "agentum",
        workerCache: workerCache(),
      }
    );

    expect(await gateway.ensureEnvironment()).toBe("env_new");
    expect(created.calls).toBe(1);
  });

  test("caches the id, so the second call makes no request", async () => {
    const created = { calls: 0 };
    const cache = memoryCache();
    let lists = 0;
    const gateway = createAnthropicGateway(
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
      { cache, environmentName: "agentum", workerCache: workerCache() }
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
  const gateway = createAnthropicGateway(
    client({
      agents: {
        update: (_id: string, body: Record<string, unknown>) => {
          updates.push(body);
          return Promise.resolve({});
        },
      },
    }),
    {
      cache: memoryCache(),
      environmentName: "agentum",
      workerCache: workerCache(),
    }
  );

  const lastUpdate = () => updates.at(-1) ?? {};

  test("declares the workspace server first, then every connector", async () => {
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      connectors: [
        { name: "connector_aaaa", url: "https://a.example.com/mcp" },
      ],
      mcpUrl: "https://app.example.com/mcp/tok",
      model: AGENT_MODEL,
      name: "Ada",
      system: "be helpful",
    });

    expect(lastUpdate().mcp_servers).toEqual([
      { name: "agentum", type: "url", url: "https://app.example.com/mcp/tok" },
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
      connectors: [
        { name: "connector_aaaa", url: "https://a.example.com/mcp" },
      ],
      mcpUrl: "https://app.example.com/mcp/tok",
      model: AGENT_MODEL,
      name: "Ada",
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
        mcp_server_name: "agentum",
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
    ]);
  });

  test("sends the model it was handed, not the workspace default", async () => {
    // Every update carries the model, so a roster resync that used the constant
    // would quietly put a re-modelled agent back on Sonnet.
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      model: "claude-opus-5",
      name: "Ada",
      system: "be helpful",
    });

    expect(lastUpdate().model).toBe("claude-opus-5");
  });

  test("leaves the whole array alone when there is no MCP URL to send", async () => {
    // The registered URL carries a token we cannot reconstruct, so a rename
    // must not touch `mcp_servers` - connectors and all.
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      connectors: [
        { name: "connector_aaaa", url: "https://a.example.com/mcp" },
      ],
      model: AGENT_MODEL,
      name: "Ada",
      system: "be helpful",
    });

    expect(lastUpdate()).not.toHaveProperty("mcp_servers");
    expect(lastUpdate()).not.toHaveProperty("tools");
  });

  test("rosters a self copy and the shared worker on every update", async () => {
    // Sent like the model: an agent registered before subagents existed picks
    // up its roster on the next resync.
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      model: AGENT_MODEL,
      name: "Ada",
      system: "be helpful",
    });

    expect(lastUpdate().multiagent).toEqual({
      agents: [{ type: "self" }, "agt_worker"],
      type: "coordinator",
    });
  });

  test("leaves the worker off an agent that shares its name", async () => {
    // Roster names must be unique, and the self entry is listed under the
    // coordinator's own name - a collision would fail validation outright.
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      model: AGENT_MODEL,
      name: WORKER_AGENT_NAME,
      system: "be helpful",
    });

    expect(lastUpdate().multiagent).toEqual({
      agents: [{ type: "self" }],
      type: "coordinator",
    });
  });

  test("rosters the agent alone when the worker cannot be created", async () => {
    // The fake client has no `agents.create`, so the lazy worker creation
    // fails - which must cost the agent its worker, not its registration.
    const bareUpdates: Record<string, unknown>[] = [];
    const bare = createAnthropicGateway(
      client({
        agents: {
          update: (_id: string, body: Record<string, unknown>) => {
            bareUpdates.push(body);
            return Promise.resolve({});
          },
        },
      }),
      {
        cache: memoryCache(),
        environmentName: "agentum",
        workerCache: memoryCache(),
      }
    );

    await bare.syncAgent({
      anthropicAgentId: "agt_1",
      model: AGENT_MODEL,
      name: "Ada",
      system: "be helpful",
    });

    expect(bareUpdates.at(-1)?.multiagent).toEqual({
      agents: [{ type: "self" }],
      type: "coordinator",
    });
  });
});

describe("worker agent", () => {
  test("is created once on the cheap model, cached, and rostered", async () => {
    const created: Record<string, unknown>[] = [];
    const cache = memoryCache();
    const gateway = createAnthropicGateway(
      client({
        agents: {
          create: (body: Record<string, unknown>) => {
            created.push(body);
            return Promise.resolve({
              id: body.name === WORKER_AGENT_NAME ? "agt_worker_new" : "agt_1",
            });
          },
          update: () => Promise.resolve({}),
        },
        memoryStores: { create: () => Promise.resolve({ id: "mem_1" }) },
      }),
      { cache: memoryCache(), environmentName: "agentum", workerCache: cache }
    );

    await gateway.registerAgent({
      instructions: "be helpful",
      mcpUrl: "https://app.example.com/mcp/tok",
      model: AGENT_MODEL,
      name: "Ada",
      system: "be helpful",
    });
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      model: AGENT_MODEL,
      name: "Ada",
      system: "be helpful",
    });

    const workers = created.filter((body) => body.name === WORKER_AGENT_NAME);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.model).toBe(WORKER_AGENT_MODEL);
    // No MCP servers: the worker cannot post to the workspace, by design.
    expect(workers[0]).not.toHaveProperty("mcp_servers");
    expect(cache.value).toBe("agt_worker_new");
    expect(created.at(-1)?.multiagent).toEqual({
      agents: [{ type: "self" }, "agt_worker_new"],
      type: "coordinator",
    });
  });
});

describe("registerAgent", () => {
  test("registers the agent on the model it was handed", async () => {
    const created: Record<string, unknown>[] = [];
    const gateway = createAnthropicGateway(
      client({
        agents: {
          create: (body: Record<string, unknown>) => {
            created.push(body);
            return Promise.resolve({ id: "agt_1" });
          },
        },
        memoryStores: { create: () => Promise.resolve({ id: "mem_1" }) },
      }),
      {
        cache: memoryCache(),
        environmentName: "agentum",
        workerCache: workerCache(),
      }
    );

    await gateway.registerAgent({
      instructions: "be helpful",
      mcpUrl: "https://app.example.com/mcp/tok",
      model: "claude-haiku-4-5-20251001",
      name: "Ada",
      system: "be helpful",
    });

    expect(created.at(-1)?.model).toBe("claude-haiku-4-5-20251001");
  });
});

describe("syncAgentSkills", () => {
  const updates: Record<string, unknown>[] = [];
  const gateway = createAnthropicGateway(
    client({
      agents: {
        update: (_id: string, body: Record<string, unknown>) => {
          updates.push(body);
          return Promise.resolve({});
        },
      },
    }),
    {
      cache: memoryCache(),
      environmentName: "agentum",
      workerCache: workerCache(),
    }
  );

  test("sends skills and nothing else", async () => {
    await gateway.syncAgentSkills({
      anthropicAgentId: "agt_1",
      skills: [
        { skillId: "skill_01", version: "latest" },
        { skillId: "skill_02", version: "1787195643170342" },
      ],
    });

    // The whole point: `mcp_servers` is untouched, so the one-time token in the
    // workspace MCP URL survives - an agent creating a skill mid-session must
    // not sever its own connection.
    expect(updates.at(-1)).toEqual({
      skills: [
        { skill_id: "skill_01", type: "custom", version: "latest" },
        {
          skill_id: "skill_02",
          type: "custom",
          version: "1787195643170342",
        },
      ],
    });
  });

  test("clears the array when the last assignment goes", async () => {
    await gateway.syncAgentSkills({ anthropicAgentId: "agt_1", skills: [] });

    expect(updates.at(-1)).toEqual({ skills: [] });
  });
});

describe("createSession", () => {
  const created: Record<string, unknown>[] = [];
  const gateway = createAnthropicGateway(
    client({
      environments: {
        list: () =>
          iterate([{ archived_at: null, id: "env_1", name: "agentum" }]),
      },
      sessions: {
        create: (body: Record<string, unknown>) => {
          created.push(body);
          return Promise.resolve({ id: "sesn_1", status: "running" });
        },
      },
    }),
    {
      cache: memoryCache(),
      environmentName: "agentum",
      workerCache: workerCache(),
    }
  );

  const session = {
    anthropicAgentId: "agt_1",
    memoryStoreId: null,
    model: AGENT_MODEL,
    text: "hello",
    title: "Ada in ch_1",
  };

  test("attaches the connector vaults", async () => {
    await gateway.createSession({
      ...session,
      vaultIds: ["vault_a", "vault_b"],
    });

    expect(created.at(-1)?.vault_ids).toEqual(["vault_a", "vault_b"]);
  });

  test("omits the field when the agent has no connectors", async () => {
    await gateway.createSession({ ...session, vaultIds: [] });

    expect(created.at(-1)).not.toHaveProperty("vault_ids");
  });

  test("runs the session on the model it was handed", async () => {
    // The per-session override is the load-bearing application point: it needs
    // no registration sync to have landed, and omitted fields are preserved.
    await gateway.createSession({ ...session, model: "claude-opus-5" });

    expect(created.at(-1)?.agent).toEqual({
      id: "agt_1",
      model: "claude-opus-5",
      type: "agent_with_overrides",
    });
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
    createAnthropicGateway(client(eventsClient(pages, seen)), {
      cache: memoryCache(),
      environmentName: "agentum",
      workerCache: workerCache(),
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
});
