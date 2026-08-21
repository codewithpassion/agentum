import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "#/db/client";

/**
 * The routines service against the shipped migrations, with the firing path
 * exercised for real: `fireRoutine` publishes a message, so what this pins down
 * is that the message it publishes is the one the router knows how to act on -
 * `origin: "routine"`, an external author, and a body whose leading `@Name`
 * resolves to a mention of this workspace's agent.
 */

// `publishMessage` reaches the channel and router Durable Objects, which import
// a module only the Workers runtime provides. `env` is exported alongside it
// because the mock registry is shared across the whole suite, and a stand-in
// that drops it would break the files that read it.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createDb } = await import("#/db/client");
const { resolveModel } = await import("#/modules/agents/model-overrides");
const { agentModelOverrides } = await import("#/modules/agents/schema");
const { AGENT_MODEL } = await import("#/modules/anthropic/config");
const { createAgent, deleteAgent } = await import("#/modules/agents/service");

const OPUS = "claude-opus-5";
const {
  addChannelMember,
  createChannel,
  deleteChannel,
  listChannelMembers,
  listChannelMessages,
} = await import("#/modules/messaging/service");
const { createWorkspace, deleteWorkspace } = await import(
  "#/modules/workspaces/service"
);
const {
  advanceRoutine,
  createRoutine,
  deleteRoutine,
  earliestNextRunAt,
  fireRoutine,
  getRoutine,
  latestRunsFor,
  listDueRoutines,
  listRoutines,
  listRuns,
  toRoutineView,
  updateRoutine,
} = await import("./service");
const { nextRun } = await import("./schedule");
type Schedule = import("./schedule").Schedule;

const migrationsDir = new URL("../../../drizzle/", import.meta.url);
/** Nothing here stores a blob; the workspace-delete cleanup still needs one. */
const bucket = {
  delete: () => Promise.resolve(),
} as unknown as R2Bucket;

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
let env: Env;
let broadcasts: { channelId: string; type: string }[];
let woken: { mentionedAgentIds: string[]; messageId: string }[];
/**
 * The override rows as they stood *at the moment the router was told*. A model
 * written after the wake would be a model the run's first turn never saw, so
 * this reads the table from inside the fan-out rather than after it.
 */
let overridesAtWake: { model: string; threadParentId: string }[][];

const fakeEnv = (d1: D1Database): Env =>
  ({
    AGENT_ROUTER: {
      get: () => ({
        notifyMessage: async (notification: {
          mentionedAgentIds: string[];
          messageId: string;
        }) => {
          woken.push(notification);
          overridesAtWake.push(
            await db
              .select({
                model: agentModelOverrides.model,
                threadParentId: agentModelOverrides.threadParentId,
              })
              .from(agentModelOverrides)
          );
        },
      }),
      idFromName: (name: string) => name,
    },
    CHANNEL_ROOM: {
      get: () => ({
        broadcast: (payload: string) => {
          broadcasts.push(
            JSON.parse(payload) as { channelId: string; type: string }
          );
          return Promise.resolve();
        },
      }),
      idFromName: (name: string) => name,
    },
    DB: d1,
  }) as unknown as Env;

interface Tenant {
  agentId: string;
  channelId: string;
  slug: string;
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
    slug: workspace.slug,
    workspaceId: workspace.id,
  };
};

const DAILY: Schedule = { time: "09:00", type: "daily" };

const routineFor = (
  tenant: Tenant,
  overrides: {
    model?: string | null;
    nextRunAt?: Date | null;
    schedule?: Schedule;
    timezone?: string;
  } = {}
) =>
  createRoutine(db, tenant.workspaceId, {
    agentId: tenant.agentId,
    channelId: tenant.channelId,
    instructions: "summarize yesterday's activity",
    model: overrides.model ?? null,
    name: "Morning summary",
    nextRunAt:
      overrides.nextRunAt === undefined
        ? nextRun(overrides.schedule ?? DAILY, "UTC", new Date())
        : overrides.nextRunAt,
    schedule: overrides.schedule ?? DAILY,
    timezone: overrides.timezone ?? "UTC",
  });

const workspaceRef = (tenant: Tenant) => ({
  id: tenant.workspaceId,
  slug: tenant.slug,
});

let alpha: Tenant;
let beta: Tenant;

beforeEach(async () => {
  const d1 = createTestD1();
  db = createDb(d1);
  env = fakeEnv(d1);
  broadcasts = [];
  woken = [];
  overridesAtWake = [];
  alpha = await seed("Alpha", "user_2aAdaAAAAAAAAAAAAAAAAAAA");
  beta = await seed("Beta", "user_2bBobBBBBBBBBBBBBBBBBBBB");
});

describe("CRUD", () => {
  test("a routine lists, reads and updates only within its workspace", async () => {
    const routine = await routineFor(alpha);

    expect(
      (await listRoutines(db, alpha.workspaceId)).map((r) => r.id)
    ).toEqual([routine.id]);
    expect(await listRoutines(db, beta.workspaceId)).toEqual([]);
    expect(await getRoutine(db, beta.workspaceId, routine.id)).toBeUndefined();
    expect(
      await updateRoutine(db, beta.workspaceId, routine.id, { name: "Stolen" })
    ).toBeUndefined();
    expect(await deleteRoutine(db, beta.workspaceId, routine.id)).toBeFalse();

    const renamed = await updateRoutine(db, alpha.workspaceId, routine.id, {
      enabled: false,
      name: "Renamed",
      nextRunAt: null,
    });
    expect(renamed?.name).toBe("Renamed");
    expect(renamed?.enabled).toBeFalse();
    expect(renamed?.nextRunAt).toBeNull();
  });

  test("the view carries the schedule back as an object", async () => {
    const routine = await routineFor(alpha, {
      schedule: { day: 1, time: "09:00", type: "weekly" },
    });
    const view = toRoutineView(routine, { agentName: "Ada" });
    expect(view.schedule).toEqual({ day: 1, time: "09:00", type: "weekly" });
    expect(view.agentName).toBe("Ada");
    expect(view.lastRun).toBeNull();
  });

  test("deleting a routine takes its runs with it", async () => {
    const routine = await routineFor(alpha);
    await fireRoutine(db, env, workspaceRef(alpha), routine, new Date());
    expect(await listRuns(db, routine.id)).toHaveLength(1);

    await deleteRoutine(db, alpha.workspaceId, routine.id);
    expect(await listRuns(db, routine.id)).toEqual([]);
  });

  test("deleting the workspace takes routines and runs with it", async () => {
    const routine = await routineFor(beta);
    await fireRoutine(db, env, workspaceRef(beta), routine, new Date());

    await deleteWorkspace(db, bucket, beta.workspaceId);

    expect(await listRoutines(db, beta.workspaceId)).toEqual([]);
    expect(await listRuns(db, routine.id)).toEqual([]);
    // And the other workspace still has its own.
    await routineFor(alpha);
    expect(await listRoutines(db, alpha.workspaceId)).toHaveLength(1);
  });
});

describe("the scheduler's queries", () => {
  test("only enabled routines whose slot has come are due", async () => {
    const past = new Date(Date.now() - 60_000);
    const due = await routineFor(alpha, { nextRunAt: past });
    await routineFor(alpha, { nextRunAt: new Date(Date.now() + 3_600_000) });
    const disabled = await routineFor(alpha, { nextRunAt: past });
    await updateRoutine(db, alpha.workspaceId, disabled.id, {
      enabled: false,
      nextRunAt: null,
    });
    // Another workspace's overdue routine must never appear.
    await routineFor(beta, { nextRunAt: past });

    const rows = await listDueRoutines(db, alpha.workspaceId, new Date());
    expect(rows.map((row) => row.id)).toEqual([due.id]);
  });

  test("the earliest pending firing is what the alarm is set to", async () => {
    const soon = new Date(Date.now() + 60_000);
    await routineFor(alpha, { nextRunAt: new Date(Date.now() + 3_600_000) });
    await routineFor(alpha, { nextRunAt: soon });

    expect((await earliestNextRunAt(db, alpha.workspaceId))?.getTime()).toBe(
      soon.getTime()
    );
    expect(await earliestNextRunAt(db, beta.workspaceId)).toBeNull();
  });
});

describe("advanceRoutine", () => {
  test("counts from the moment it is given, not from the missed slot", async () => {
    const missed = new Date(Date.now() - 3 * 24 * 3_600_000);
    const routine = await routineFor(alpha, { nextRunAt: missed });

    const now = new Date();
    const advanced = await advanceRoutine(db, routine, now);

    expect(advanced?.nextRunAt?.getTime()).toBe(
      nextRun(DAILY, "UTC", now)?.getTime()
    );
    expect(advanced?.nextRunAt?.getTime()).toBeGreaterThan(now.getTime());
  });

  test("a `once` has nothing left, so the routine disables itself", async () => {
    const routine = await routineFor(alpha, {
      nextRunAt: new Date(Date.now() - 1000),
      schedule: { at: "2026-08-21T09:00", type: "once" },
    });

    const advanced = await advanceRoutine(
      db,
      routine,
      new Date("2026-08-21T09:00:00Z")
    );

    expect(advanced?.enabled).toBeFalse();
    expect(advanced?.nextRunAt).toBeNull();
  });

  test("a schedule that stopped parsing stops the routine too", async () => {
    const routine = await routineFor(alpha);

    const advanced = await advanceRoutine(
      db,
      { ...routine, schedule: "not json" },
      new Date()
    );
    expect(advanced?.enabled).toBeFalse();
    expect(advanced?.nextRunAt).toBeNull();
  });
});

describe("fireRoutine", () => {
  test("posts the instructions as a routine-authored mention", async () => {
    const routine = await routineFor(alpha);
    const scheduledFor = new Date(Date.now() - 5000);

    const run = await fireRoutine(
      db,
      env,
      workspaceRef(alpha),
      routine,
      scheduledFor
    );

    expect(run.status).toBe("posted");
    expect(run.error).toBeNull();
    expect(run.scheduledFor.getTime()).toBe(scheduledFor.getTime());

    const { messages } = await listChannelMessages(db, workspaceRef(alpha), {
      channelId: alpha.channelId,
      limit: 10,
    });
    const [message] = messages;
    expect(message?.id).toBe(run.messageId ?? "");
    expect(message?.body).toBe("@Ada summarize yesterday's activity");
    expect(message?.origin).toBe("routine");
    expect(message?.authorType).toBe("external");
    expect(message?.authorId).toBe(`routine:${routine.id}`);
    // The mention resolved, which is the whole wake mechanism.
    expect(message?.mentions.map((mention) => mention.agentId)).toEqual([
      alpha.agentId,
    ]);
    // And the router was told about it, with the agent as a live target.
    expect(woken).toHaveLength(1);
    expect(woken[0]?.mentionedAgentIds).toEqual([alpha.agentId]);
    expect(broadcasts.map((event) => event.type)).toEqual(["message.created"]);
  });

  test("adds the agent to the channel, so a mention can still wake it", async () => {
    const routine = await routineFor(alpha);
    expect(
      await listChannelMembers(db, alpha.workspaceId, alpha.channelId)
    ).toEqual([]);

    await fireRoutine(db, env, workspaceRef(alpha), routine, new Date());

    const members = await listChannelMembers(
      db,
      alpha.workspaceId,
      alpha.channelId
    );
    expect(members.map((member) => member.memberId)).toEqual([alpha.agentId]);
  });

  test("is idempotent about membership somebody else already granted", async () => {
    await addChannelMember(db, alpha.channelId, {
      memberId: alpha.agentId,
      memberType: "agent",
    });
    const routine = await routineFor(alpha);

    const run = await fireRoutine(
      db,
      env,
      workspaceRef(alpha),
      routine,
      new Date()
    );

    expect(run.status).toBe("posted");
    expect(
      await listChannelMembers(db, alpha.workspaceId, alpha.channelId)
    ).toHaveLength(1);
  });

  test("a deleted agent leaves an error run, and the routine survives", async () => {
    const routine = await routineFor(alpha);
    await deleteAgent(db, alpha.workspaceId, alpha.agentId);

    const run = await fireRoutine(
      db,
      env,
      workspaceRef(alpha),
      routine,
      new Date()
    );

    expect(run.status).toBe("error");
    expect(run.error).toContain("agent");
    expect(run.messageId).toBeNull();
    expect(await getRoutine(db, alpha.workspaceId, routine.id)).toBeDefined();
  });

  test("a deleted channel leaves an error run too", async () => {
    const routine = await routineFor(alpha);
    await deleteChannel(db, alpha.workspaceId, alpha.channelId);

    const run = await fireRoutine(
      db,
      env,
      workspaceRef(alpha),
      routine,
      new Date()
    );

    expect(run.status).toBe("error");
    expect(run.error).toContain("channel");
  });

  test("a routine with a model of its own overrides the thread before waking anyone", async () => {
    const routine = await routineFor(alpha, { model: OPUS });

    const run = await fireRoutine(
      db,
      env,
      workspaceRef(alpha),
      routine,
      new Date()
    );

    expect(run.status).toBe("posted");
    // The row was already there when the router was told - a run inherits its
    // model on its first turn, not its second.
    expect(overridesAtWake).toEqual([
      [{ model: OPUS, threadParentId: run.messageId ?? "" }],
    ]);
    expect(
      await resolveModel(db, {
        agentId: alpha.agentId,
        channelId: alpha.channelId,
        threadParentId: run.messageId,
      })
    ).toBe(OPUS);
    // Everything else about the firing is unchanged.
    expect(woken).toHaveLength(1);
    expect(broadcasts.map((event) => event.type)).toEqual(["message.created"]);
  });

  test("a routine on the agent's own model writes no override at all", async () => {
    const routine = await routineFor(alpha);

    const run = await fireRoutine(
      db,
      env,
      workspaceRef(alpha),
      routine,
      new Date()
    );

    expect(overridesAtWake).toEqual([[]]);
    expect(
      await resolveModel(db, {
        agentId: alpha.agentId,
        channelId: alpha.channelId,
        threadParentId: run.messageId,
      })
    ).toBe(AGENT_MODEL);
  });

  test("a fan-out that blows up mid-sequence is an error run, not a throw", async () => {
    // The model branch splits the publish in two, so it is the one path where
    // a failure lands between the write and the wake. An alarm firing a list of
    // routines has to reach the next one either way.
    const routine = await routineFor(alpha, { model: OPUS });
    const exploding = {
      ...fakeEnv(env.DB),
      CHANNEL_ROOM: {
        get: () => ({
          broadcast: () => Promise.reject(new Error("the room is gone")),
        }),
        idFromName: (name: string) => name,
      },
    } as unknown as Env;

    const run = await fireRoutine(
      db,
      exploding,
      workspaceRef(alpha),
      routine,
      new Date()
    );

    expect(run.status).toBe("error");
    expect(run.error).toBe("the room is gone");
    expect(await getRoutine(db, alpha.workspaceId, routine.id)).toBeDefined();
  });

  test("a model on a routine whose channel is gone still only leaves an error run", async () => {
    const routine = await routineFor(alpha, { model: OPUS });
    await deleteChannel(db, alpha.workspaceId, alpha.channelId);

    const run = await fireRoutine(
      db,
      env,
      workspaceRef(alpha),
      routine,
      new Date()
    );

    expect(run.status).toBe("error");
    expect(overridesAtWake).toEqual([]);
  });

  test("running now writes history without touching the schedule", async () => {
    const soon = new Date(Date.now() + 3_600_000);
    const routine = await routineFor(alpha, { nextRunAt: soon });

    await fireRoutine(db, env, workspaceRef(alpha), routine, new Date());

    const after = await getRoutine(db, alpha.workspaceId, routine.id);
    expect(after?.nextRunAt?.getTime()).toBe(soon.getTime());
    expect(after?.enabled).toBeTrue();
    expect(await listRuns(db, routine.id)).toHaveLength(1);
  });

  test("the latest run is what the list view shows", async () => {
    const routine = await routineFor(alpha);
    await fireRoutine(db, env, workspaceRef(alpha), routine, new Date());
    // `fired_at` is the sort key, and both runs would otherwise land in the
    // same millisecond.
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await fireRoutine(
      db,
      env,
      workspaceRef(alpha),
      routine,
      new Date()
    );

    const latest = await latestRunsFor(db, [routine.id]);
    expect(latest.get(routine.id)?.id).toBe(second.id);
    expect(
      toRoutineView(routine, { lastRun: latest.get(routine.id) }).lastRun
        ?.channelId
    ).toBe(alpha.channelId);
  });
});
