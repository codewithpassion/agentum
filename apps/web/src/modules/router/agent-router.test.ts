import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "#/db/client";
import { agents } from "#/modules/agents/schema";

/**
 * The router Durable Object, one per workspace since phase 5.
 *
 * Two things are worth a test here and nothing else is: that the instance
 * learns which workspace it is (it cannot read back the name it was addressed
 * with, so the tenant has to arrive with the traffic), and that every agent
 * lookup it makes stops at that workspace - the digest sweep in particular,
 * which used to walk every agent in the deployment.
 *
 * No Anthropic key is set, so `wake` finds no gateway and settles for writing
 * the agent's status: exactly the observable this needs, with no network.
 */

const storage = () => {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    alarms: () => alarm,
    api: {
      delete: (key: string) => {
        values.delete(key);
        return Promise.resolve(true);
      },
      deleteAlarm: () => {
        alarm = null;
        return Promise.resolve();
      },
      deleteAll: () => {
        values.clear();
        return Promise.resolve();
      },
      get: (key: string) => Promise.resolve(values.get(key)),
      list: ({ prefix }: { prefix: string }) =>
        Promise.resolve(
          new Map(
            [...values].filter(([key]) => key.startsWith(prefix)) as [
              string,
              never,
            ][]
          )
        ),
      put: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
      setAlarm: (at: number) => {
        alarm = at;
        return Promise.resolve();
      },
    },
    values,
  };
};

type Storage = ReturnType<typeof storage>;

// The real base class only supplies `ctx` and `env`; the harness below hands
// in its own, so an in-memory stand-in is the whole of what it needs to be.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  env: {},
}));

const { createAgent, getAgentById, setAgentRegistration } = await import(
  "#/modules/agents/service"
);
const { upsertOverride } = await import("#/modules/agents/model-overrides");
const { AGENT_MODEL } = await import("#/modules/anthropic/config");
const { CLOUDFLARE_DEFAULT_MODEL } = await import("#/modules/runner/models");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { AgentRouter, routerStub } = await import("./agent-router");
const { SESSION_IDLE_TTL_MS } = await import("./config");
const { DIGEST_KEY, SESSION_KEY, WORKSPACE_KEY } = await import("./state");
type AnthropicGateway = import("#/modules/anthropic/gateway").AnthropicGateway;
type CreateSessionInput =
  import("#/modules/anthropic/gateway").CreateSessionInput;
type MessageNotification = import("./wake-decision").MessageNotification;
type StoredSession = import("./state").StoredSession;

const OPUS = "claude-opus-5";
const HAIKU = "claude-haiku-4-5-20251001";

const migrate = (): Db => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }
  const database = drizzle(sqlite) as unknown as Db;
  // The bun-sqlite driver has no `batch`, but drizzle statements are
  // thenables, so running them in turn is a faithful enough stand-in -
  // `createMessage` (the death notice) is the one write here that uses it.
  Object.assign(database, {
    batch: (statements: PromiseLike<unknown>[]) => Promise.all(statements),
  });
  return database;
};

let db: Db;
let broadcasts: { agentId?: string; channelId: string; type: string }[];

/**
 * The channel rooms the router fans status out to, as a binding rather than a
 * module mock: `mock.module` is global to the whole suite, and this only has
 * to be true here.
 */
const channelRooms = () => ({
  get: () => ({
    broadcast: (payload: string) => {
      broadcasts.push(
        JSON.parse(payload) as { channelId: string; type: string }
      );
      return Promise.resolve();
    },
  }),
  idFromName: (name: string) => name,
});

/**
 * A router wired to the in-memory database, with an Anthropic key present so
 * `notifyMessage` does its work - the gateway itself is never reached, because
 * neither agent here is registered.
 */
const routerFor = (store: Storage, gateway?: AnthropicGateway) => {
  const ctx = { storage: store.api } as unknown as DurableObjectState;
  const env = {
    ANTHROPIC_API_KEY: "sk-test",
    CHANNEL_ROOM: channelRooms(),
    DB: {},
  } as unknown as Env;
  const instance = new AgentRouter(ctx, env);
  if (gateway) {
    // An own property shadows the prototype method, which is how a fake reaches
    // a Durable Object that builds its own gateway from `env`.
    Object.assign(instance, { gateway: () => gateway });
  }
  // `DurableObject` is module-mocked, and the whole suite shares one registry -
  // so whose stand-in wins the race is not this file's to decide. Both fields
  // are set here rather than relying on a base constructor to have done it.
  // The `Db` too: the object would otherwise build its own from the binding,
  // and the fixtures wrote to this one.
  Object.assign(instance, { ctx, database: db, env });
  return instance;
};

/** Records what the router asked Anthropic for; makes no calls of its own. */
const fakeGateway = () => {
  const calls = {
    created: [] as CreateSessionInput[],
    sent: [] as { sessionId: string; text: string }[],
  };
  const gateway: AnthropicGateway = {
    createSession: (input) => {
      calls.created.push(input);
      return Promise.resolve({
        sessionId: `sesn_${calls.created.length}`,
        status: "running" as const,
      });
    },
    deleteSession: () => Promise.resolve(),
    ensureEnvironment: () => Promise.resolve("env_1"),
    getSession: () => Promise.resolve("idle" as const),
    pollEvents: () => Promise.resolve({ cursor: undefined, events: [] }),
    registerAgent: () =>
      Promise.resolve({ anthropicAgentId: "agt_1", memoryStoreId: null }),
    sendMessage: (sessionId, text) => {
      calls.sent.push({ sessionId, text });
      return Promise.resolve();
    },
    syncAgent: () => Promise.resolve(),
    syncAgentSkills: () => Promise.resolve(),
  };
  return { calls, gateway };
};

interface Tenant {
  agentId: string;
  channelId: string;
  workspaceId: string;
}

const seed = async (name: string, clerkUserId: string): Promise<Tenant> => {
  const { workspace } = await createWorkspace(db, {
    name,
    owner: {
      clerkUserId,
      email: `${clerkUserId}@example.com`,
      imageUrl: null,
      name: "Owner",
    },
  });
  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });
  return {
    agentId: agent.id,
    channelId: `channel-${name}`,
    workspaceId: workspace.id,
  };
};

const notification = (
  tenant: Tenant,
  overrides: Partial<MessageNotification> = {}
): MessageNotification => ({
  authorId: "member-1",
  authorName: "Ada Lovelace",
  authorType: "user",
  body: "@Researcher take a look",
  channelId: tenant.channelId,
  channelKind: "channel",
  channelName: "general",
  createdAt: Date.now(),
  memberAgentIds: [tenant.agentId],
  mentionedAgentIds: [tenant.agentId],
  messageId: crypto.randomUUID(),
  origin: "native",
  threadParentId: null,
  workspaceId: tenant.workspaceId,
  ...overrides,
});

/** Registered, so a wake has something to talk to, and on `model`. */
const register = async (tenant: Tenant, model: string | null) => {
  await setAgentRegistration(db, tenant.agentId, {
    anthropicAgentId: "agt_1",
    memoryStoreId: null,
  });
  await db.update(agents).set({ model }).where(eq(agents.id, tenant.agentId));
};

const override = (tenant: Tenant, channelId: string, model: string) =>
  upsertOverride(db, {
    agentId: tenant.agentId,
    channelId,
    createdBy: `agent:${tenant.agentId}`,
    model,
    workspaceId: tenant.workspaceId,
  });

/** A live session on the workspace default, waiting to be reused. */
const storedSession = (): StoredSession => ({
  channelId: alpha.channelId,
  cursorAt: null,
  cursorId: null,
  lastActivityAt: Date.now(),
  model: AGENT_MODEL,
  sessionId: "sesn_old",
  status: "idle",
});

const digestEntry = (channelId: string) => ({
  authorName: "Ada Lovelace",
  body: "have a look",
  channelId,
  channelKind: "channel" as const,
  channelName: "general",
  createdAt: Date.now(),
  messageId: crypto.randomUUID(),
  threadParentId: null,
});

let alpha: Tenant;
let beta: Tenant;

beforeEach(async () => {
  db = migrate();
  broadcasts = [];
  alpha = await seed("Alpha", "user_2aAdaAAAAAAAAAAAAAAAAAAA");
  beta = await seed("Beta", "user_2bBobBBBBBBBBBBBBBBBBBBB");
});

describe("routerStub", () => {
  test("addresses one instance per workspace", () => {
    const names: string[] = [];
    const env = {
      AGENT_ROUTER: {
        get: (id: string) => id,
        idFromName: (name: string) => {
          names.push(name);
          return name;
        },
      },
    } as unknown as Env;

    routerStub(env, alpha.workspaceId);
    routerStub(env, beta.workspaceId);

    expect(names).toEqual([alpha.workspaceId, beta.workspaceId]);
  });
});

describe("notifyMessage", () => {
  test("records the workspace the traffic arrived from", async () => {
    const store = storage();
    await routerFor(store).notifyMessage(notification(alpha));

    expect(store.values.get(WORKSPACE_KEY)).toBe(alpha.workspaceId);
  });
});

describe("the alarm", () => {
  test("wakes the mentioned agent of its own workspace", async () => {
    const store = storage();
    const router = routerFor(store);

    await router.notifyMessage(notification(alpha));
    await router.alarm();

    // Unregistered, so the wake resolves to "nothing to talk to" - but it is
    // this workspace's agent whose status was written, which is the point.
    expect(
      (await getAgentById(db, alpha.workspaceId, alpha.agentId))?.status
    ).toBe("idle");
    expect(
      broadcasts.filter((event) => event.type === "agent.status")
    ).toHaveLength(1);
  });

  test("a message in one workspace never reaches the other's agent", async () => {
    const store = storage();
    const router = routerFor(store);

    // A marker the router would have to overwrite for the wake to have landed.
    await db
      .update(agents)
      .set({ status: "working" })
      .where(eq(agents.id, beta.agentId));

    // The same-named agent of the *other* workspace, named as a member and a
    // mention: the router must refuse it because the ids are not its own.
    await router.notifyMessage(
      notification(alpha, {
        memberAgentIds: [beta.agentId],
        mentionedAgentIds: [beta.agentId],
      })
    );
    await router.alarm();

    expect(broadcasts).toEqual([]);
    // Not even the status write lands: an id from another workspace moves
    // nothing, which a bare `WHERE id = ?` would not have managed.
    expect(
      (await getAgentById(db, beta.workspaceId, beta.agentId))?.status
    ).toBe("working");
  });

  test("the digest sweep stops at its own workspace's agents", async () => {
    const store = storage();
    const router = routerFor(store);

    // A digest waiting for each workspace's agent, in one instance's storage:
    // the sweep used to list every agent in the deployment, so B's entry would
    // have been picked up here.
    await router.notifyMessage(notification(alpha, { mentionedAgentIds: [] }));
    await store.api.put(DIGEST_KEY(beta.agentId), [
      {
        authorName: "Bob",
        body: "hello",
        channelId: beta.channelId,
        channelKind: "channel",
        channelName: "general",
        createdAt: Date.now(),
        messageId: "message-b",
        threadParentId: null,
      },
    ]);

    // Due now, so `flushDigests` actually runs.
    await store.api.put("nextDigestAt", Date.now() - 1);
    await router.alarm();

    // A's digest was taken; B's is still sitting there untouched.
    expect(store.values.get(DIGEST_KEY(alpha.agentId))).toBeUndefined();
    expect(store.values.get(DIGEST_KEY(beta.agentId))).toBeDefined();
  });

  test("a stored session on another model is dropped for a fresh one", async () => {
    const store = storage();
    const { calls, gateway } = fakeGateway();
    const router = routerFor(store, gateway);
    await register(alpha, OPUS);
    await store.api.put(SESSION_KEY(alpha.agentId), storedSession());

    await router.notifyMessage(notification(alpha));
    await router.alarm();

    // The session it was holding runs on Sonnet and cannot be re-modelled, so
    // the wake starts a new one instead of sending into it.
    expect(calls.sent).toEqual([]);
    expect(calls.created.map((input) => input.model)).toEqual([OPUS]);
    const session = store.values.get(
      SESSION_KEY(alpha.agentId)
    ) as StoredSession;
    expect(session.sessionId).toBe("sesn_1");
    expect(session.model).toBe(OPUS);
  });

  test("a top-level channel mention retires an idle session for a fresh one", async () => {
    const store = storage();
    const { calls, gateway } = fakeGateway();
    const router = routerFor(store, gateway);
    await register(alpha, null);
    await store.api.put(SESSION_KEY(alpha.agentId), storedSession());

    await router.notifyMessage(notification(alpha));
    await router.alarm();

    // A new top-level ask is a new task: it gets a session with a full budget
    // rather than the tail of whatever the old one had left.
    expect(calls.sent).toEqual([]);
    expect(calls.created).toHaveLength(1);
    expect(
      (store.values.get(SESSION_KEY(alpha.agentId)) as StoredSession).sessionId
    ).toBe("sesn_1");
  });

  test("a session cut off by its budget is retired and says so", async () => {
    const store = storage();
    const { gateway } = fakeGateway();
    gateway.pollEvents = () =>
      Promise.resolve({
        cursor: undefined,
        events: [
          {
            id: "evt-idle",
            processedAt: "2026-08-21T06:00:40Z",
            stopReason: "budget_reached",
            type: "session.status_idle",
          },
        ],
      });
    const router = routerFor(store, gateway);
    await register(alpha, null);
    await store.api.put(WORKSPACE_KEY, alpha.workspaceId);
    await store.api.put(SESSION_KEY(alpha.agentId), {
      ...storedSession(),
      status: "running",
    });

    await router.alarm();

    // The spent session is gone - reusing it would just die again - and the
    // channel heard why, instead of the silence that used to follow.
    expect(store.values.get(SESSION_KEY(alpha.agentId))).toBeUndefined();
    expect(broadcasts).toContainEqual(
      expect.objectContaining({
        channelId: alpha.channelId,
        type: "message.created",
      })
    );
    expect(broadcasts).toContainEqual(
      expect.objectContaining({ status: "error", type: "agent.status" })
    );
  });

  test("a quiet running session is kept while the API says it still runs", async () => {
    const store = storage();
    const { gateway } = fakeGateway();
    gateway.getSession = () => Promise.resolve("running" as const);
    const router = routerFor(store, gateway);
    await register(alpha, null);
    await store.api.put(WORKSPACE_KEY, alpha.workspaceId);
    await store.api.put(SESSION_KEY(alpha.agentId), {
      ...storedSession(),
      lastActivityAt: Date.now() - SESSION_IDLE_TTL_MS - 1,
      status: "running",
    });

    await router.alarm();

    // A coordinator waiting on a subagent thread can be silent for the whole
    // TTL - the session stream carries child threads only in outline - and
    // retiring it live would rotate the MCP token out from under its report.
    const session = store.values.get(
      SESSION_KEY(alpha.agentId)
    ) as StoredSession;
    expect(session.sessionId).toBe("sesn_old");
    expect(session.lastActivityAt).toBeGreaterThan(
      Date.now() - SESSION_IDLE_TTL_MS
    );
  });

  test("a quiet session the API says is done is retired", async () => {
    const store = storage();
    const { gateway } = fakeGateway();
    // The fake's `getSession` answers "idle": stored as running, but the work
    // is over - the quiet stretch really was the session ending unobserved.
    const router = routerFor(store, gateway);
    await register(alpha, null);
    await store.api.put(WORKSPACE_KEY, alpha.workspaceId);
    await store.api.put(SESSION_KEY(alpha.agentId), {
      ...storedSession(),
      lastActivityAt: Date.now() - SESSION_IDLE_TTL_MS - 1,
      status: "running",
    });

    await router.alarm();

    expect(store.values.get(SESSION_KEY(alpha.agentId))).toBeUndefined();
  });

  test("a quiet idle session is retired without asking the API", async () => {
    const store = storage();
    const { gateway } = fakeGateway();
    let asked = 0;
    gateway.getSession = () => {
      asked += 1;
      return Promise.resolve("running" as const);
    };
    const router = routerFor(store, gateway);
    await register(alpha, null);
    await store.api.put(WORKSPACE_KEY, alpha.workspaceId);
    await store.api.put(SESSION_KEY(alpha.agentId), {
      ...storedSession(),
      lastActivityAt: Date.now() - SESSION_IDLE_TTL_MS - 1,
    });

    await router.alarm();

    // An idle session this old is just not worth resuming; only a *running*
    // one earns the status check.
    expect(asked).toBe(0);
    expect(store.values.get(SESSION_KEY(alpha.agentId))).toBeUndefined();
  });

  test("a session stored before this feature counts as the default", async () => {
    const store = storage();
    const { calls, gateway } = fakeGateway();
    const router = routerFor(store, gateway);
    await register(alpha, null);
    const { model, ...withoutModel } = storedSession();
    await store.api.put(SESSION_KEY(alpha.agentId), withoutModel);

    // A thread reply, because that is the wake that still reuses a session -
    // a top-level mention starts a fresh one by design.
    await router.notifyMessage(
      notification(alpha, { threadParentId: "msg-parent" })
    );
    await router.alarm();

    // The agent is on the default too, so there is nothing to churn.
    expect(calls.created).toEqual([]);
    expect(calls.sent.map((call) => call.sessionId)).toEqual(["sesn_old"]);
    expect(
      (store.values.get(SESSION_KEY(alpha.agentId)) as StoredSession).model
    ).toBe(AGENT_MODEL);
  });

  test("an override carries when the whole batch is in one conversation", async () => {
    const store = storage();
    const { calls, gateway } = fakeGateway();
    const router = routerFor(store, gateway);
    await register(alpha, null);
    await override(alpha, alpha.channelId, OPUS);

    await router.notifyMessage(notification(alpha));
    await router.alarm();

    expect(calls.created.map((input) => input.model)).toEqual([OPUS]);
  });

  test("a batch spanning conversations falls back to the agent's own model", async () => {
    const store = storage();
    const { calls, gateway } = fakeGateway();
    const router = routerFor(store, gateway);
    await register(alpha, HAIKU);
    // One of the two channels the digest spans has an override; the other does
    // not, and one session cannot run on two models.
    await override(alpha, alpha.channelId, OPUS);
    await store.api.put(DIGEST_KEY(alpha.agentId), [
      digestEntry(alpha.channelId),
      digestEntry("channel-elsewhere"),
    ]);
    await store.api.put(WORKSPACE_KEY, alpha.workspaceId);

    await store.api.put("nextDigestAt", Date.now() - 1);
    await router.alarm();

    expect(calls.created.map((input) => input.model)).toEqual([HAIKU]);
  });

  test("the retired global singleton drops its state instead of acting on it", async () => {
    const store = storage();
    // What the pre-multi-tenancy `idFromName("router")` instance looks like:
    // sessions and digests, and no workspace to scope them to.
    await store.api.put(DIGEST_KEY(alpha.agentId), []);
    await store.api.put("session:legacy", { status: "running" });
    await store.api.setAlarm(Date.now());

    await routerFor(store).alarm();

    expect(store.values.size).toBe(0);
    expect(store.alarms()).toBeNull();
    expect(broadcasts).toEqual([]);
  });
});

describe("the Cloudflare runtime", () => {
  /** A runner namespace that records what the router asked of it. */
  const fakeRunners = () => {
    const started: { agentId: string; model: string; text: string }[] = [];
    const namespace = {
      get: () => ({
        events: () => Promise.resolve([]),
        send: () => Promise.resolve(),
        start: (input: { agentId: string; model: string; text: string }) => {
          started.push(input);
          return Promise.resolve();
        },
        status: () => Promise.resolve("running"),
        stop: () => Promise.resolve(),
      }),
      idFromName: (name: string) => name,
    };
    return { namespace, started };
  };

  const seedCloudflareAgent = async (model: string | null) => {
    const { agent } = await createAgent(db, alpha.workspaceId, {
      instructions: "",
      model,
      name: "Edge",
      runtime: "cloudflare",
      soul: "",
    });
    return agent.id;
  };

  test("wakes through its runner with no Anthropic registration or key", async () => {
    const store = storage();
    const runners = fakeRunners();
    const router = routerFor(store);
    // No Anthropic key at all: the managed gateway would be null, and a
    // managed agent would settle for an idle status here.
    Object.assign(router, {
      env: {
        ...(router as unknown as { env: Env }).env,
        AGENT_RUNNER: runners.namespace,
        ANTHROPIC_API_KEY: undefined,
      },
      gateway: () => Promise.resolve(null),
    });
    const edgeId = await seedCloudflareAgent(null);

    await router.notifyMessage(
      notification(alpha, {
        body: "@Edge take a look",
        memberAgentIds: [edgeId],
        mentionedAgentIds: [edgeId],
      })
    );
    await router.alarm();

    expect(runners.started).toHaveLength(1);
    expect(runners.started[0]?.agentId).toBe(edgeId);
    expect(runners.started[0]?.model).toBe(CLOUDFLARE_DEFAULT_MODEL);
    expect(runners.started[0]?.text).toContain("take a look");
    const agent = await getAgentById(db, alpha.workspaceId, edgeId);
    expect(agent?.status).toBe("working");
    expect(agent?.sessionId).not.toBeNull();
    expect(store.values.get(SESSION_KEY(edgeId))).toMatchObject({
      runtime: "cloudflare",
      status: "running",
    });
  });

  test("runs on its own model and ignores conversation overrides", async () => {
    const store = storage();
    const runners = fakeRunners();
    const router = routerFor(store);
    Object.assign(router, {
      env: {
        ...(router as unknown as { env: Env }).env,
        AGENT_RUNNER: runners.namespace,
      },
    });
    const edgeId = await seedCloudflareAgent("@cf/zai-org/glm-4.7-flash");
    // An override naming an Anthropic model: meaningless to this runtime.
    await upsertOverride(db, {
      agentId: edgeId,
      channelId: alpha.channelId,
      createdBy: `agent:${edgeId}`,
      model: OPUS,
      workspaceId: alpha.workspaceId,
    });

    await router.notifyMessage(
      notification(alpha, {
        memberAgentIds: [edgeId],
        mentionedAgentIds: [edgeId],
      })
    );
    await router.alarm();

    expect(runners.started[0]?.model).toBe("@cf/zai-org/glm-4.7-flash");
  });

  test("a managed agent still needs its registration", async () => {
    const store = storage();
    const runners = fakeRunners();
    const router = routerFor(store);
    Object.assign(router, {
      env: {
        ...(router as unknown as { env: Env }).env,
        AGENT_RUNNER: runners.namespace,
      },
    });

    await router.notifyMessage(notification(alpha));
    await router.alarm();

    expect(runners.started).toEqual([]);
    expect(
      (await getAgentById(db, alpha.workspaceId, alpha.agentId))?.status
    ).toBe("idle");
  });
});
