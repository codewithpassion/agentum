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

const { createAgent, getAgentById } = await import("#/modules/agents/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { AgentRouter, routerStub } = await import("./agent-router");
const { DIGEST_KEY, WORKSPACE_KEY } = await import("./state");
type MessageNotification = import("./wake-decision").MessageNotification;

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
  return drizzle(sqlite) as unknown as Db;
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
const routerFor = (store: Storage) => {
  const ctx = { storage: store.api } as unknown as DurableObjectState;
  const env = {
    ANTHROPIC_API_KEY: "sk-test",
    CHANNEL_ROOM: channelRooms(),
    DB: {},
  } as unknown as Env;
  const instance = new AgentRouter(ctx, env);
  // `DurableObject` is module-mocked, and the whole suite shares one registry -
  // so whose stand-in wins the race is not this file's to decide. Both fields
  // are set here rather than relying on a base constructor to have done it.
  // The `Db` too: the object would otherwise build its own from the binding,
  // and the fixtures wrote to this one.
  Object.assign(instance, { ctx, database: db, env });
  return instance;
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
