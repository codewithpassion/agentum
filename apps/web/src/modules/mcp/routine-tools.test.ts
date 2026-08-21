import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createDb, type Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";

/**
 * An agent looking after its own routines: the three scenarios the plan names -
 * "create a routine that runs weekdays at 5am", "what routines are set up",
 * "change the 5am check to 6am" - plus the refusals, which matter more here
 * than on the HTTP side. A form can show a validation error; an agent can only
 * act on one it can read, so every refusal comes back as tool text.
 *
 * Self-scoping is the other half. A routine belonging to another agent answers
 * exactly what an id nobody has answers, in the same words.
 */

mock.module("cloudflare:workers", () => ({
  DurableObject: class {},
  env: {},
}));

const { createAgent } = await import("#/modules/agents/service");
const { createChannel } = await import("#/modules/messaging/service");
const { createRoutine, getRoutine, listRoutines } = await import(
  "#/modules/routines/service"
);
const { createWorkspace } = await import("#/modules/workspaces/service");
const { routineCreate, routineDelete, routineList, routineUpdate } =
  await import("./routine-tools");
type McpToolContext = import("./tools").McpToolContext;

const OPUS = "claude-opus-5";
const SONNET = "claude-sonnet-5";
const ZONE = "Australia/Sydney";

const migrate = (): Db => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }

  return createDb({
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
  } as unknown as D1Database);
};

/** Every mutation has to re-arm the workspace's scheduler; this counts it. */
let rearmed: string[] = [];

const fakeEnv = (): Env =>
  ({
    ROUTINE_SCHEDULER: {
      get: () => ({
        reschedule: (workspaceId: string) => {
          rearmed.push(workspaceId);
          return Promise.resolve();
        },
      }),
      idFromName: (name: string) => name,
    },
  }) as unknown as Env;

const payloadOf = (result: CallToolResult): Record<string, unknown> => {
  const [block] = result.content;
  if (block?.type !== "text") {
    throw new Error("expected a text block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
};

const textOf = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === "text" ? block.text : "";
};

interface Tenant {
  agent: Agent;
  channelId: string;
  ctx: McpToolContext;
  workspace: { id: string; slug: string };
}

let db: Db;
let alpha: Tenant;
let beta: Tenant;

const seed = async (name: string, clerkUserId: string): Promise<Tenant> => {
  const { workspace } = await createWorkspace(db, {
    name,
    owner: {
      clerkUserId,
      email: `${clerkUserId}@example.com`,
      imageUrl: null,
      name,
    },
  });
  const ref = { id: workspace.id, slug: workspace.slug };
  const { agent } = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Researcher",
    soul: "",
  });
  const channel = await createChannel(db, workspace.id, { name: "general" });

  return {
    agent,
    channelId: channel.id,
    ctx: {
      agent,
      db,
      env: fakeEnv(),
      requestUrl: "https://app.example.com/mcp/tok",
      workspace: ref,
    },
    workspace: ref,
  };
};

const create = (
  tenant: Tenant,
  overrides: Record<string, unknown> = {}
): Promise<CallToolResult> =>
  routineCreate(tenant.ctx, {
    channelId: tenant.channelId,
    instructions: "Check my email and give me a rundown.",
    name: "Morning email rundown",
    schedule: { time: "05:00", type: "daily", weekdaysOnly: true },
    timezone: ZONE,
    ...overrides,
  } as Parameters<typeof routineCreate>[1]);

beforeEach(async () => {
  db = migrate();
  rearmed = [];
  alpha = await seed("Alpha", "user_2aAdaAAAAAAAAAAAAAAAAAAA");
  beta = await seed("Beta", "user_2bBobBBBBBBBBBBBBBBBBBBB");
});

describe("routine_create", () => {
  test("takes the weekdays-at-5am routine the plan asks for", async () => {
    const result = await create(alpha, { model: SONNET });

    expect(payloadOf(result)).toMatchObject({
      model: SONNET,
      name: "Morning email rundown",
      schedule: "every weekday at 05:00",
      timezone: ZONE,
    });
    const [stored] = await listRoutines(db, alpha.workspace.id);
    expect(stored).toMatchObject({
      agentId: alpha.agent.id,
      model: SONNET,
    });
    expect(stored?.nextRunAt).not.toBeNull();
  });

  test("re-arms the workspace's scheduler", async () => {
    await create(alpha);

    expect(rearmed).toEqual([alpha.workspace.id]);
  });

  test("leaves the model null when none is asked for", async () => {
    const result = await create(alpha);

    expect(payloadOf(result)).toMatchObject({ model: "agent default" });
    expect((await listRoutines(db, alpha.workspace.id))[0]?.model).toBeNull();
  });

  test.each([
    [{ at: "2099-01-01T09:00", type: "once" }, "once, at 2099-01-01T09:00"],
    [{ time: "09:00", type: "daily" }, "every day at 09:00"],
    [{ day: 1, time: "09:00", type: "weekly" }, "every Monday at 09:00"],
    [{ everyMinutes: 120, type: "interval" }, "every 2 hour(s)"],
    [{ expr: "0 9 * * 1-5", type: "cron" }, "cron: 0 9 * * 1-5"],
  ])("accepts a %o schedule", async (schedule, described) => {
    const result = await create(alpha, { schedule });

    expect(result.isError).toBeUndefined();
    expect(payloadOf(result).schedule).toBe(described);
  });

  test("refuses a schedule with no future run, in words it can retry from", async () => {
    const result = await create(alpha, {
      schedule: { at: "2020-01-01T09:00", type: "once" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("This schedule has no future run.");
    expect(await listRoutines(db, alpha.workspace.id)).toHaveLength(0);
  });

  test("refuses a time zone Intl does not know", async () => {
    const result = await create(alpha, { timezone: "Mars/Olympus" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not a known time zone");
  });

  test("refuses a schedule the parser rejects", async () => {
    const result = await create(alpha, {
      schedule: { time: "half five", type: "daily" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('"time"');
  });

  test("refuses a model outside the catalog", async () => {
    const result = await create(alpha, { model: "gpt-9" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(OPUS);
    expect(await listRoutines(db, alpha.workspace.id)).toHaveLength(0);
  });

  test("refuses another workspace's channel", async () => {
    const result = await create(alpha, { channelId: beta.channelId });

    expect(result.isError).toBe(true);
    expect(await listRoutines(db, alpha.workspace.id)).toHaveLength(0);
  });
});

describe("routine_list", () => {
  test("is the agent's own routines, and only those", async () => {
    await create(alpha);
    const { agent: other } = await createAgent(db, alpha.workspace.id, {
      instructions: "",
      name: "Scribe",
      soul: "",
    });
    await createRoutine(db, alpha.workspace.id, {
      agentId: other.id,
      channelId: alpha.channelId,
      instructions: "Not yours.",
      name: "Someone else's",
      nextRunAt: new Date(Date.now() + 86_400_000),
      schedule: { time: "07:00", type: "daily" },
      timezone: ZONE,
    });
    await create(beta);

    const listed = payloadOf(await routineList(alpha.ctx)).routines as {
      name: string;
    }[];

    expect(listed.map((routine) => routine.name)).toEqual([
      "Morning email rundown",
    ]);
  });

  test("reads back the schedule, the channel and the model in plain terms", async () => {
    await create(alpha, { model: OPUS });

    const [listed] = payloadOf(await routineList(alpha.ctx)).routines as {
      channelName: string;
      enabled: boolean;
      lastRun: unknown;
      model: string;
      nextRunAt: string;
      schedule: string;
    }[];

    expect(listed).toMatchObject({
      channelName: "general",
      enabled: true,
      lastRun: null,
      model: OPUS,
      schedule: "every weekday at 05:00",
    });
    expect(Date.parse(String(listed?.nextRunAt))).toBeGreaterThan(Date.now());
  });
});

describe("routine_update", () => {
  const idOf = async (tenant: Tenant): Promise<string> => {
    const created = payloadOf(await create(tenant));
    return created.id as string;
  };

  test('moves the 5am check to 6am - "change the 5am check to 6am"', async () => {
    const routineId = await idOf(alpha);
    rearmed = [];

    const result = await routineUpdate(alpha.ctx, {
      routineId,
      schedule: { time: "06:00", type: "daily", weekdaysOnly: true },
    });

    expect(payloadOf(result)).toMatchObject({
      schedule: "every weekday at 06:00",
    });
    expect(rearmed).toEqual([alpha.workspace.id]);
    const stored = await getRoutine(db, alpha.workspace.id, routineId);
    expect(stored?.schedule).toContain("06:00");
  });

  test("touches only what it was given", async () => {
    const routineId = await idOf(alpha);

    await routineUpdate(alpha.ctx, { name: "Renamed", routineId });

    const stored = await getRoutine(db, alpha.workspace.id, routineId);
    expect(stored).toMatchObject({
      instructions: "Check my email and give me a rundown.",
      name: "Renamed",
      timezone: ZONE,
    });
  });

  test("sets and clears the model", async () => {
    const routineId = await idOf(alpha);

    await routineUpdate(alpha.ctx, { model: OPUS, routineId });
    expect((await getRoutine(db, alpha.workspace.id, routineId))?.model).toBe(
      OPUS
    );

    const cleared = await routineUpdate(alpha.ctx, {
      model: "default",
      routineId,
    });
    expect(payloadOf(cleared)).toMatchObject({ model: "agent default" });
    expect(
      (await getRoutine(db, alpha.workspace.id, routineId))?.model
    ).toBeNull();
  });

  test("pausing clears the next run; the row survives", async () => {
    const routineId = await idOf(alpha);

    const result = await routineUpdate(alpha.ctx, {
      enabled: false,
      routineId,
    });

    expect(payloadOf(result)).toMatchObject({
      enabled: false,
      nextRunAt: null,
    });
    expect(await getRoutine(db, alpha.workspace.id, routineId)).toBeDefined();
  });

  test("refuses to re-enable a routine with nothing left to run", async () => {
    const created = payloadOf(
      await create(alpha, {
        schedule: { at: "2099-01-01T09:00", type: "once" },
      })
    );
    const routineId = created.id as string;
    await routineUpdate(alpha.ctx, { enabled: false, routineId });

    const result = await routineUpdate(alpha.ctx, {
      enabled: true,
      routineId,
      schedule: { at: "2020-01-01T09:00", type: "once" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("This schedule has no future run.");
  });

  test("another agent's routine reads exactly like one that never existed", async () => {
    const { agent: other } = await createAgent(db, alpha.workspace.id, {
      instructions: "",
      name: "Scribe",
      soul: "",
    });
    const theirs = await createRoutine(db, alpha.workspace.id, {
      agentId: other.id,
      channelId: alpha.channelId,
      instructions: "Not yours.",
      name: "Someone else's",
      nextRunAt: new Date(Date.now() + 86_400_000),
      schedule: { time: "07:00", type: "daily" },
      timezone: ZONE,
    });

    const foreign = await routineUpdate(alpha.ctx, {
      name: "Mine now",
      routineId: theirs.id,
    });
    const invented = await routineUpdate(alpha.ctx, {
      name: "Mine now",
      routineId: "routine_nobody_has",
    });

    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toBe(
      textOf(invented).replace("routine_nobody_has", theirs.id)
    );
    expect((await getRoutine(db, alpha.workspace.id, theirs.id))?.name).toBe(
      "Someone else's"
    );
  });

  test("cannot move a routine into another workspace's channel", async () => {
    const routineId = await idOf(alpha);

    const result = await routineUpdate(alpha.ctx, {
      channelId: beta.channelId,
      routineId,
    });

    expect(result.isError).toBe(true);
    expect(
      (await getRoutine(db, alpha.workspace.id, routineId))?.channelId
    ).toBe(alpha.channelId);
  });
});

describe("routine_delete", () => {
  test("deletes its own and re-arms the scheduler", async () => {
    const routineId = payloadOf(await create(alpha)).id as string;
    rearmed = [];

    const result = await routineDelete(alpha.ctx, { routineId });

    expect(payloadOf(result)).toMatchObject({ deleted: true });
    expect(rearmed).toEqual([alpha.workspace.id]);
    expect(await listRoutines(db, alpha.workspace.id)).toHaveLength(0);
  });

  test("refuses another workspace's routine without touching it", async () => {
    const routineId = payloadOf(await create(beta)).id as string;

    const result = await routineDelete(alpha.ctx, { routineId });

    expect(result.isError).toBe(true);
    expect(await listRoutines(db, beta.workspace.id)).toHaveLength(1);
  });
});
