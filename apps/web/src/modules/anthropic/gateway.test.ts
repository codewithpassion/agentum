import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicGateway, type EnvironmentCache } from "./gateway";

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

const memoryCache = (): EnvironmentCache & { value: string | null } => ({
  read() {
    return Promise.resolve(this.value);
  },
  value: null,
  write(environmentId: string) {
    this.value = environmentId;
    return Promise.resolve();
  },
});

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
      { cache: memoryCache(), environmentName: "agentum" }
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
      { cache: memoryCache(), environmentName: "agentum" }
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
      { cache, environmentName: "agentum" }
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
    { cache: memoryCache(), environmentName: "agentum" }
  );

  const lastUpdate = () => updates.at(-1) ?? {};

  test("declares the workspace server first, then every connector", async () => {
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      connectors: [
        { name: "connector_aaaa", url: "https://a.example.com/mcp" },
      ],
      mcpUrl: "https://app.example.com/mcp/tok",
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

  test("leaves the whole array alone when there is no MCP URL to send", async () => {
    // The registered URL carries a token we cannot reconstruct, so a rename
    // must not touch `mcp_servers` - connectors and all.
    await gateway.syncAgent({
      anthropicAgentId: "agt_1",
      connectors: [
        { name: "connector_aaaa", url: "https://a.example.com/mcp" },
      ],
      name: "Ada",
      system: "be helpful",
    });

    expect(lastUpdate()).not.toHaveProperty("mcp_servers");
    expect(lastUpdate()).not.toHaveProperty("tools");
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
    { cache: memoryCache(), environmentName: "agentum" }
  );

  const session = {
    anthropicAgentId: "agt_1",
    memoryStoreId: null,
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
