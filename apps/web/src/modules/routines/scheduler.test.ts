import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "#/db/client";

/**
 * The scheduler Durable Object: one alarm per workspace, and what happens when
 * it goes off.
 *
 * Time is not faked - the routines are simply given a `next_run_at` in the past,
 * which is exactly the state the alarm exists to resolve. What matters here is
 * that a due routine fires once, that a routine whose slot passed days ago
 * collapses into a single catch-up run scheduled from now, that a "once" takes
 * itself out of service afterwards, and that the alarm is left pointing at the
 * next thing to do.
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

// The real base class only supplies `ctx` and `env`; the harness hands in its
// own, so an in-memory stand-in is the whole of what it needs to be.
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

const { createDb } = await import("#/db/client");
const { createAgent } = await import("#/modules/agents/service");
const { createChannel, listChannelMessages } = await import(
  "#/modules/messaging/service"
);
const { createWorkspace } = await import("#/modules/workspaces/service");
const { RoutineScheduler, schedulerStub, WORKSPACE_KEY } = await import(
  "./scheduler"
);
const { createRoutine, getRoutine, listRuns } = await import("./service");
type Schedule = import("./schedule").Schedule;

const migrationsDir = new URL("../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDir),
      "utf8"
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }

  return {
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database;
};

let db: Db;
let d1: D1Database;

const fakeEnv = (): Env =>
  ({
    AGENT_ROUTER: {
      get: () => ({ notifyMessage: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    CHANNEL_ROOM: {
      get: () => ({ broadcast: () => Promise.resolve() }),
      idFromName: (name: string) => name,
    },
    DB: d1,
  }) as unknown as Env;

const schedulerFor = (store: Storage) => {
  const ctx = { storage: store.api } as unknown as DurableObjectState;
  const env = fakeEnv();
  const instance = new RoutineScheduler(ctx, env);
  // `DurableObject` is module-mocked and the whole suite shares one registry,
  // so whose stand-in wins the race is not this file's to decide: both fields
  // are set here rather than relying on a base constructor. The `Db` too - the
  // object would otherwise build its own from the binding, and the fixtures
  // wrote to this one.
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
    name: "Ada",
    soul: "",
  });
  const channel = await createChannel(db, workspace.id, { name: "ops" });
  return {
    agentId: agent.id,
    channelId: channel.id,
    workspaceId: workspace.id,
  };
};

const DAILY: Schedule = { time: "09:00", type: "daily" };
const DAY_MS = 86_400_000;

const routineFor = (
  tenant: Tenant,
  options: { nextRunAt: Date | null; schedule?: Schedule }
) =>
  createRoutine(db, tenant.workspaceId, {
    agentId: tenant.agentId,
    channelId: tenant.channelId,
    instructions: "summarize yesterday's activity",
    name: "Morning summary",
    nextRunAt: options.nextRunAt,
    schedule: options.schedule ?? DAILY,
    timezone: "UTC",
  });

const messagesIn = async (tenant: Tenant) =>
  (
    await listChannelMessages(
      db,
      { id: tenant.workspaceId, slug: "alpha" },
      { channelId: tenant.channelId, limit: 10 }
    )
  ).messages;

let alpha: Tenant;
let beta: Tenant;

beforeEach(async () => {
  d1 = createTestD1();
  db = createDb(d1);
  alpha = await seed("Alpha", "user_2aAdaAAAAAAAAAAAAAAAAAAA");
  beta = await seed("Beta", "user_2bBobBBBBBBBBBBBBBBBBBBB");
});

describe("schedulerStub", () => {
  test("addresses one instance per workspace", () => {
    const names: string[] = [];
    const env = {
      ROUTINE_SCHEDULER: {
        get: (id: string) => id,
        idFromName: (name: string) => {
          names.push(name);
          return name;
        },
      },
    } as unknown as Env;

    schedulerStub(env, alpha.workspaceId);
    schedulerStub(env, beta.workspaceId);

    expect(names).toEqual([alpha.workspaceId, beta.workspaceId]);
  });
});

describe("reschedule", () => {
  test("records the workspace it was called for and arms the earliest slot", async () => {
    const store = storage();
    const soon = new Date(Date.now() + 60_000);
    await routineFor(alpha, { nextRunAt: new Date(Date.now() + DAY_MS) });
    await routineFor(alpha, { nextRunAt: soon });

    await schedulerFor(store).reschedule(alpha.workspaceId);

    expect(store.values.get(WORKSPACE_KEY)).toBe(alpha.workspaceId);
    expect(store.alarms()).toBe(soon.getTime());
  });

  test("clears the alarm when nothing is left to fire", async () => {
    const store = storage();
    const routine = await routineFor(alpha, {
      nextRunAt: new Date(Date.now() + 60_000),
    });
    const scheduler = schedulerFor(store);
    await scheduler.reschedule(alpha.workspaceId);
    expect(store.alarms()).not.toBeNull();

    const { deleteRoutine } = await import("./service");
    await deleteRoutine(db, alpha.workspaceId, routine.id);
    await scheduler.reschedule(alpha.workspaceId);

    expect(store.alarms()).toBeNull();
  });
});

describe("the alarm", () => {
  test("fires the due routine, records the run and re-arms", async () => {
    const store = storage();
    const routine = await routineFor(alpha, {
      nextRunAt: new Date(Date.now() - 1000),
    });
    const scheduler = schedulerFor(store);
    await scheduler.reschedule(alpha.workspaceId);

    await scheduler.alarm();

    const messages = await messagesIn(alpha);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toBe("@Ada summarize yesterday's activity");
    expect(messages[0]?.origin).toBe("routine");
    expect(messages[0]?.mentions.map((mention) => mention.agentId)).toEqual([
      alpha.agentId,
    ]);

    const [run] = await listRuns(db, routine.id);
    expect(run?.status).toBe("posted");
    expect(run?.messageId).toBe(messages[0]?.id ?? "");

    const after = await getRoutine(db, alpha.workspaceId, routine.id);
    expect(after?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(store.alarms()).toBe(after?.nextRunAt?.getTime() ?? 0);
  });

  test("a routine that has been due for days fires once, from now", async () => {
    const store = storage();
    const missedBy = 3 * DAY_MS;
    const routine = await routineFor(alpha, {
      nextRunAt: new Date(Date.now() - missedBy),
    });
    const scheduler = schedulerFor(store);
    await scheduler.reschedule(alpha.workspaceId);

    await scheduler.alarm();

    // One catch-up run, not three.
    expect(await messagesIn(alpha)).toHaveLength(1);
    expect(await listRuns(db, routine.id)).toHaveLength(1);

    const after = await getRoutine(db, alpha.workspaceId, routine.id);
    const nextRunAt = after?.nextRunAt?.getTime() ?? 0;
    expect(nextRunAt).toBeGreaterThan(Date.now());
    // Within a day: counted from now, not from the slot it missed.
    expect(nextRunAt).toBeLessThanOrEqual(Date.now() + DAY_MS);
  });

  test("a `once` routine disables itself after it has run", async () => {
    const store = storage();
    const routine = await routineFor(alpha, {
      nextRunAt: new Date(Date.now() - 1000),
      schedule: { at: "2026-01-01T09:00", type: "once" },
    });
    const scheduler = schedulerFor(store);
    await scheduler.reschedule(alpha.workspaceId);

    await scheduler.alarm();

    const after = await getRoutine(db, alpha.workspaceId, routine.id);
    expect(after?.enabled).toBeFalse();
    expect(after?.nextRunAt).toBeNull();
    expect(store.alarms()).toBeNull();
    expect((await listRuns(db, routine.id))[0]?.status).toBe("posted");
  });

  test("another workspace's overdue routine is none of its business", async () => {
    const store = storage();
    await routineFor(beta, { nextRunAt: new Date(Date.now() - 1000) });
    const scheduler = schedulerFor(store);
    await scheduler.reschedule(alpha.workspaceId);

    await scheduler.alarm();

    expect(await messagesIn(beta)).toEqual([]);
    expect(store.alarms()).toBeNull();
  });

  test("an alarm with no workspace drops its state instead of acting", async () => {
    const store = storage();
    await store.api.put("stale", "value");
    await store.api.setAlarm(Date.now());
    await routineFor(alpha, { nextRunAt: new Date(Date.now() - 1000) });

    await schedulerFor(store).alarm();

    expect(store.values.size).toBe(0);
    expect(store.alarms()).toBeNull();
    expect(await messagesIn(alpha)).toEqual([]);
  });

  test("a deleted workspace's scheduler retires itself", async () => {
    const store = storage();
    await routineFor(alpha, { nextRunAt: new Date(Date.now() - 1000) });
    const scheduler = schedulerFor(store);
    await scheduler.reschedule(alpha.workspaceId);

    const { deleteWorkspace } = await import("#/modules/workspaces/service");
    await deleteWorkspace(db, alpha.workspaceId);
    await scheduler.alarm();

    expect(store.values.size).toBe(0);
    expect(store.alarms()).toBeNull();
  });
});
