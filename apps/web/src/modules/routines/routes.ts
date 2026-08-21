import { type Context, Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  parsePositiveInt,
  readJsonObject,
  requireString,
} from "#/api/validation";
import { createDb, type Db } from "#/db/client";
import { getAgentById, getAgentsByIds } from "#/modules/agents/service";
import { getChannel, listChannels } from "#/modules/messaging/service";
import type { Schedule } from "./schedule";
import { rescheduleRoutines } from "./scheduler";
import type { Routine } from "./schema";
import {
  createRoutine,
  deleteRoutine,
  fireRoutine,
  getRoutine,
  latestRunsFor,
  listRoutines,
  listRuns,
  type RoutineView,
  toRoutineView,
  toRunView,
  updateRoutine,
} from "./service";
import {
  type Checked,
  checkModel,
  checkSchedule,
  checkTimezone,
  firstRunAt,
  nextRunAfterChange,
} from "./validate";

/**
 * The routines API, workspace-scoped like every other resource router.
 *
 * Scoping lives here: the agent and the channel have to resolve *within this
 * workspace*, which is what makes another tenant's id a 404 rather than a
 * working routine. What makes a routine well-formed lives in `validate.ts`,
 * because the agents' MCP tools accept the same routine from the other
 * direction and must refuse exactly what this does; the adapter below is the
 * only difference - a reason becomes a 400 here and tool text there.
 */

const NAME_MAX_LENGTH = 120;
const INSTRUCTIONS_MAX_LENGTH = 10_000;
const RUNS_PAGE_DEFAULT = 20;
const RUNS_PAGE_MAX = 100;

const orBadRequest = <T>(checked: Checked<T>): T => {
  if (!checked.ok) {
    throw badRequest(checked.reason);
  }
  return checked.value;
};

const views = async (
  db: Db,
  workspaceId: string,
  rows: readonly Routine[]
): Promise<RoutineView[]> => {
  if (rows.length === 0) {
    return [];
  }
  const [agents, channels, lastRuns] = await Promise.all([
    getAgentsByIds(
      db,
      rows.map((row) => row.agentId)
    ),
    listChannels(db, workspaceId),
    latestRunsFor(
      db,
      rows.map((row) => row.id)
    ),
  ]);
  const agentNames = new Map(agents.map((agent) => [agent.id, agent.name]));
  const channelNames = new Map(
    channels.map((channel) => [channel.id, channel.name])
  );

  return rows.map((row) =>
    toRoutineView(row, {
      agentName: agentNames.get(row.agentId) ?? null,
      channelName: channelNames.get(row.channelId) ?? null,
      lastRun: lastRuns.get(row.id) ?? null,
    })
  );
};

const view = async (db: Db, workspaceId: string, row: Routine) => {
  const [only] = await views(db, workspaceId, [row]);
  if (!only) {
    throw new Error("Failed to build the routine view.");
  }
  return only;
};

const requireRoutine = async (
  c: Context<ApiEnv>,
  db: Db,
  id: string
): Promise<Routine> => {
  const routine = await getRoutine(db, c.get("workspace").id, id);
  if (!routine) {
    throw notFound("Routine not found.");
  }
  return routine;
};

/** Both are resolved scoped, so another workspace's id never lands on a row. */
const requireTargets = async (
  c: Context<ApiEnv>,
  db: Db,
  targets: { agentId?: string; channelId?: string }
): Promise<void> => {
  const workspaceId = c.get("workspace").id;
  if (
    targets.agentId !== undefined &&
    !(await getAgentById(db, workspaceId, targets.agentId))
  ) {
    throw notFound("Agent not found.");
  }
  if (
    targets.channelId !== undefined &&
    !(await getChannel(db, workspaceId, targets.channelId))
  ) {
    throw notFound("Channel not found.");
  }
};

const requireSchedule = (body: Record<string, unknown>): Schedule =>
  orBadRequest(checkSchedule(body.schedule));

const requireTimezone = (body: Record<string, unknown>): string =>
  orBadRequest(checkTimezone(body.timezone));

/**
 * Absent leaves the model as it is, `null` puts the routine back on its agent's
 * model, and a string has to be one the deployment offers.
 */
const optionalModel = (
  body: Record<string, unknown>
): string | null | undefined =>
  body.model === undefined ? undefined : orBadRequest(checkModel(body.model));

const readEnabled = (body: Record<string, unknown>): boolean | undefined => {
  if (body.enabled === undefined) {
    return;
  }
  if (typeof body.enabled !== "boolean") {
    throw badRequest('"enabled" must be a boolean.');
  }
  return body.enabled;
};

export const routinesRoutes = new Hono<ApiEnv>();

routinesRoutes.use("*", requireAuth);

routinesRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  return c.json({
    routines: await views(db, workspaceId, await listRoutines(db, workspaceId)),
  });
});

routinesRoutes.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");
  const body = await readJsonObject(c.req.raw);

  const agentId = requireString(body, "agentId");
  const channelId = requireString(body, "channelId");
  await requireTargets(c, db, { agentId, channelId });

  const schedule = requireSchedule(body);
  const timezone = requireTimezone(body);
  const nextRunAt = orBadRequest(firstRunAt(schedule, timezone));

  const routine = await createRoutine(db, workspace.id, {
    agentId,
    channelId,
    instructions: requireString(body, "instructions", {
      maxLength: INSTRUCTIONS_MAX_LENGTH,
    }),
    model: optionalModel(body) ?? null,
    name: requireString(body, "name", { maxLength: NAME_MAX_LENGTH }),
    nextRunAt,
    schedule,
    timezone,
  });
  await rescheduleRoutines(c.env, workspace.id);

  return c.json({ routine: await view(db, workspace.id, routine) }, 201);
});

routinesRoutes.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");
  const routine = await requireRoutine(c, db, c.req.param("id"));
  const runs = await listRuns(db, routine.id, { limit: RUNS_PAGE_DEFAULT });

  return c.json({
    routine: await view(db, workspace.id, routine),
    runs: runs.map((run) => toRunView(run, routine.channelId)),
  });
});

routinesRoutes.patch("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");
  const routine = await requireRoutine(c, db, c.req.param("id"));
  const body = await readJsonObject(c.req.raw);

  const agentId =
    body.agentId === undefined ? undefined : requireString(body, "agentId");
  const channelId =
    body.channelId === undefined ? undefined : requireString(body, "channelId");
  await requireTargets(c, db, { agentId, channelId });

  const schedule =
    body.schedule === undefined ? undefined : requireSchedule(body);
  const timezone =
    body.timezone === undefined ? undefined : requireTimezone(body);
  const enabled = readEnabled(body);
  const nextRunAt = orBadRequest(
    nextRunAfterChange(routine, { enabled, schedule, timezone })
  );

  const updated = await updateRoutine(db, workspace.id, routine.id, {
    agentId,
    channelId,
    enabled,
    instructions:
      body.instructions === undefined
        ? undefined
        : requireString(body, "instructions", {
            maxLength: INSTRUCTIONS_MAX_LENGTH,
          }),
    model: optionalModel(body),
    name:
      body.name === undefined
        ? undefined
        : requireString(body, "name", { maxLength: NAME_MAX_LENGTH }),
    nextRunAt,
    schedule,
    timezone,
  });
  if (!updated) {
    throw notFound("Routine not found.");
  }
  await rescheduleRoutines(c.env, workspace.id);

  return c.json({ routine: await view(db, workspace.id, updated) });
});

routinesRoutes.delete("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");
  if (!(await deleteRoutine(db, workspace.id, c.req.param("id")))) {
    throw notFound("Routine not found.");
  }
  await rescheduleRoutines(c.env, workspace.id);
  return c.body(null, 204);
});

/** Paged run history, newest first; `before` is a run's `firedAt`. */
routinesRoutes.get("/:id/runs", async (c) => {
  const db = createDb(c.env.DB);
  const routine = await requireRoutine(c, db, c.req.param("id"));

  const limit = parsePositiveInt(c.req.query("limit"), {
    fallback: RUNS_PAGE_DEFAULT,
    max: RUNS_PAGE_MAX,
  });
  const rawBefore = c.req.query("before");
  const before = rawBefore === undefined ? undefined : Number(rawBefore);
  if (before !== undefined && !Number.isFinite(before)) {
    throw badRequest('"before" must be a timestamp in milliseconds.');
  }

  const runs = await listRuns(db, routine.id, {
    before: before === undefined ? undefined : new Date(before),
    limit,
  });
  return c.json({
    nextBefore:
      runs.length === limit ? (runs.at(-1)?.firedAt.getTime() ?? null) : null,
    runs: runs.map((run) => toRunView(run, routine.channelId)),
  });
});

/**
 * "Run now": the firing path without the schedule advance, so a manual run
 * neither consumes the next slot nor moves it.
 */
routinesRoutes.post("/:id/run", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");
  const routine = await requireRoutine(c, db, c.req.param("id"));

  const run = await fireRoutine(db, c.env, workspace, routine, new Date());
  return c.json({ run: toRunView(run, routine.channelId) }, 201);
});
