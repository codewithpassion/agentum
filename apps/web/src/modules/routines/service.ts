import { and, asc, desc, eq, inArray, isNotNull, lt, lte } from "drizzle-orm";
import type { Db } from "#/db/client";
import { upsertOverride } from "#/modules/agents/model-overrides";
import { getAgentById } from "#/modules/agents/service";
import { fanOutMessage, publishMessage } from "#/modules/messaging/publish";
import {
  addChannelMember,
  type CreateMessageResult,
  createMessage,
  getChannel,
  type WorkspaceRef,
} from "#/modules/messaging/service";
import { nextRun, parseSchedule, type Schedule } from "./schedule";
import {
  ROUTINE_ORIGIN,
  type Routine,
  type RoutineRun,
  type RoutineRunStatus,
  routineRuns,
  routines,
} from "./schema";

/**
 * Routines: the rows, and the one thing they do - fire.
 *
 * Firing is a message. `fireRoutine` posts the instructions into the routine's
 * channel as `@Agent <instructions>` with `origin: "routine"`, and the existing
 * publish path takes it from there: the mention is parsed, the router wakes the
 * agent, the agent answers in the thread. Both callers use it - the scheduler's
 * alarm and the "Run now" button - which is why it lives here rather than
 * inside the Durable Object.
 *
 * The workspace arrives as a parameter rather than being looked up: this module
 * must not depend on the workspaces module, which already depends on this one
 * for the delete cleanup.
 */

const RUN_PAGE_SIZE = 20;

export interface RoutineRunView {
  /** The routine's channel, so a client can link straight to the thread. */
  channelId: string;
  error: string | null;
  firedAt: number;
  id: string;
  messageId: string | null;
  routineId: string;
  scheduledFor: number;
  status: RoutineRunStatus;
}

export interface RoutineView {
  agentId: string;
  /** Null when the agent has since been deleted - the routine still lists. */
  agentName: string | null;
  channelId: string;
  channelName: string | null;
  createdAt: number;
  enabled: boolean;
  id: string;
  instructions: string;
  lastRun: RoutineRunView | null;
  /** A catalog model id, or null for whatever the agent itself runs on. */
  model: string | null;
  name: string;
  nextRunAt: number | null;
  /** Null only for a row whose stored schedule no longer parses. */
  schedule: Schedule | null;
  timezone: string;
  updatedAt: number;
}

export interface CreateRoutineInput {
  agentId: string;
  channelId: string;
  instructions: string;
  /** A catalog model id, or null/omitted for the agent's own model. */
  model?: string | null;
  name: string;
  nextRunAt: Date | null;
  schedule: Schedule;
  timezone: string;
}

export interface UpdateRoutineInput {
  agentId?: string;
  channelId?: string;
  enabled?: boolean;
  instructions?: string;
  /** Absent leaves it alone; null puts the routine back on the agent's model. */
  model?: string | null;
  name?: string;
  /** Recomputed by the caller whenever the schedule, zone or toggle changes. */
  nextRunAt?: Date | null;
  schedule?: Schedule;
  timezone?: string;
}

/** The stored JSON as a `Schedule`, or null if it no longer parses. */
export const scheduleOf = (routine: Routine): Schedule | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(routine.schedule);
  } catch {
    return null;
  }
  const parsed = parseSchedule(raw);
  return parsed.ok ? parsed.schedule : null;
};

export const toRunView = (
  run: RoutineRun,
  channelId: string
): RoutineRunView => ({
  channelId,
  error: run.error,
  firedAt: run.firedAt.getTime(),
  id: run.id,
  messageId: run.messageId,
  routineId: run.routineId,
  scheduledFor: run.scheduledFor.getTime(),
  status: run.status,
});

export const toRoutineView = (
  routine: Routine,
  extras: {
    agentName?: string | null;
    channelName?: string | null;
    lastRun?: RoutineRun | null;
  } = {}
): RoutineView => ({
  agentId: routine.agentId,
  agentName: extras.agentName ?? null,
  channelId: routine.channelId,
  channelName: extras.channelName ?? null,
  createdAt: routine.createdAt.getTime(),
  enabled: routine.enabled,
  id: routine.id,
  instructions: routine.instructions,
  lastRun: extras.lastRun ? toRunView(extras.lastRun, routine.channelId) : null,
  model: routine.model,
  name: routine.name,
  nextRunAt: routine.nextRunAt?.getTime() ?? null,
  schedule: scheduleOf(routine),
  timezone: routine.timezone,
  updatedAt: routine.updatedAt.getTime(),
});

// --- routines ---------------------------------------------------------------

export const listRoutines = (db: Db, workspaceId: string): Promise<Routine[]> =>
  db
    .select()
    .from(routines)
    .where(eq(routines.workspaceId, workspaceId))
    .orderBy(asc(routines.name));

export const getRoutine = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<Routine | undefined> => {
  const [routine] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.workspaceId, workspaceId), eq(routines.id, id)));
  return routine;
};

export const createRoutine = async (
  db: Db,
  workspaceId: string,
  input: CreateRoutineInput
): Promise<Routine> => {
  const [routine] = await db
    .insert(routines)
    .values({
      agentId: input.agentId,
      channelId: input.channelId,
      id: crypto.randomUUID(),
      instructions: input.instructions,
      model: input.model ?? null,
      name: input.name,
      nextRunAt: input.nextRunAt,
      schedule: JSON.stringify(input.schedule),
      timezone: input.timezone,
      workspaceId,
    })
    .returning();
  if (!routine) {
    throw new Error("Failed to create the routine.");
  }
  return routine;
};

export const updateRoutine = async (
  db: Db,
  workspaceId: string,
  id: string,
  input: UpdateRoutineInput
): Promise<Routine | undefined> => {
  const [routine] = await db
    .update(routines)
    .set({
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      ...(input.channelId === undefined ? {} : { channelId: input.channelId }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.instructions === undefined
        ? {}
        : { instructions: input.instructions }),
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.nextRunAt === undefined ? {} : { nextRunAt: input.nextRunAt }),
      ...(input.schedule === undefined
        ? {}
        : { schedule: JSON.stringify(input.schedule) }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      updatedAt: new Date(),
    })
    .where(and(eq(routines.workspaceId, workspaceId), eq(routines.id, id)))
    .returning();
  return routine;
};

export const deleteRoutine = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<boolean> => {
  const routine = await getRoutine(db, workspaceId, id);
  if (!routine) {
    return false;
  }
  // Runs carry no workspace of their own; they are reached through the routine,
  // and deleted with it rather than left to a cascade the local database may
  // not be enforcing.
  await db.delete(routineRuns).where(eq(routineRuns.routineId, routine.id));
  await db.delete(routines).where(eq(routines.id, routine.id));
  return true;
};

/** Every routine of one workspace, with its runs, for the workspace delete. */
export const deleteRoutinesForWorkspace = async (
  db: Db,
  workspaceId: string
): Promise<void> => {
  const rows = await db
    .select({ id: routines.id })
    .from(routines)
    .where(eq(routines.workspaceId, workspaceId));
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(routineRuns).where(inArray(routineRuns.routineId, ids));
  }
  await db.delete(routines).where(eq(routines.workspaceId, workspaceId));
};

// --- the scheduler's queries ------------------------------------------------

/** Enabled routines whose slot has come - the alarm's whole input. */
export const listDueRoutines = (
  db: Db,
  workspaceId: string,
  now: Date
): Promise<Routine[]> =>
  db
    .select()
    .from(routines)
    .where(
      and(
        eq(routines.workspaceId, workspaceId),
        eq(routines.enabled, true),
        isNotNull(routines.nextRunAt),
        lte(routines.nextRunAt, now)
      )
    )
    .orderBy(asc(routines.nextRunAt));

/** The workspace's earliest pending firing, or null when nothing is armed. */
export const earliestNextRunAt = async (
  db: Db,
  workspaceId: string
): Promise<Date | null> => {
  const [row] = await db
    .select({ nextRunAt: routines.nextRunAt })
    .from(routines)
    .where(
      and(
        eq(routines.workspaceId, workspaceId),
        eq(routines.enabled, true),
        isNotNull(routines.nextRunAt)
      )
    )
    .orderBy(asc(routines.nextRunAt))
    .limit(1);
  return row?.nextRunAt ?? null;
};

/**
 * Moves the routine on to its next slot, counted from `from` rather than from
 * the slot that just fired: a scheduler that was down for a day fires once and
 * carries on, instead of replaying a backlog.
 *
 * A schedule with nothing left - a "once", or one that stopped parsing -
 * disables the routine, which is also what takes it out of the min-scan.
 */
export const advanceRoutine = async (
  db: Db,
  routine: Routine,
  from: Date
): Promise<Routine | undefined> => {
  const schedule = scheduleOf(routine);
  const next = schedule ? nextRun(schedule, routine.timezone, from) : null;
  const [updated] = await db
    .update(routines)
    .set({
      enabled: next !== null,
      nextRunAt: next,
      updatedAt: new Date(),
    })
    .where(eq(routines.id, routine.id))
    .returning();
  return updated;
};

// --- runs -------------------------------------------------------------------

export const listRuns = (
  db: Db,
  routineId: string,
  options: { before?: Date; limit?: number } = {}
): Promise<RoutineRun[]> => {
  const limit = options.limit ?? RUN_PAGE_SIZE;
  return db
    .select()
    .from(routineRuns)
    .where(
      and(
        eq(routineRuns.routineId, routineId),
        // Strictly older, so a page never repeats the row it was cut at.
        options.before ? lt(routineRuns.firedAt, options.before) : undefined
      )
    )
    .orderBy(desc(routineRuns.firedAt))
    .limit(limit);
};

/** The most recent run of each routine, for the list view's status dot. */
export const latestRunsFor = async (
  db: Db,
  routineIds: readonly string[]
): Promise<Map<string, RoutineRun>> => {
  if (routineIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select()
    .from(routineRuns)
    .where(inArray(routineRuns.routineId, [...routineIds]))
    .orderBy(desc(routineRuns.firedAt));

  const latest = new Map<string, RoutineRun>();
  for (const row of rows) {
    if (!latest.has(row.routineId)) {
      latest.set(row.routineId, row);
    }
  }
  return latest;
};

const startRun = async (
  db: Db,
  input: { firedAt: Date; routineId: string; scheduledFor: Date }
): Promise<RoutineRun> => {
  const [run] = await db
    .insert(routineRuns)
    .values({
      firedAt: input.firedAt,
      id: crypto.randomUUID(),
      routineId: input.routineId,
      scheduledFor: input.scheduledFor,
      status: "pending",
    })
    .returning();
  if (!run) {
    throw new Error("Failed to record the routine run.");
  }
  return run;
};

const finishRun = async (
  db: Db,
  id: string,
  outcome:
    | { error: string; status: "error" }
    | { messageId: string; status: "posted" }
): Promise<RoutineRun> => {
  const [run] = await db
    .update(routineRuns)
    .set(
      outcome.status === "posted"
        ? { error: null, messageId: outcome.messageId, status: "posted" }
        : { error: outcome.error, status: "error" }
    )
    .where(eq(routineRuns.id, id))
    .returning();
  if (!run) {
    throw new Error("Failed to finalize the routine run.");
  }
  return run;
};

// --- firing -----------------------------------------------------------------

/**
 * One firing: a run row, then the instruction message, then the outcome on the
 * run row. Never throws - a failed post is history too, and the caller (an
 * alarm) has to carry on to the next routine either way.
 *
 * The agent is added to the channel first. Membership is what the router reads
 * to decide who may be woken, and it is idempotent, so a routine keeps working
 * after somebody removes the agent from the channel by hand.
 *
 * A routine with a model of its own splits the publish in two - persist, write
 * the thread override, then fan out - because fanning out is what wakes the
 * router. Committing the override first is the whole reason the split exists:
 * the run inherits the model from its first turn rather than its second.
 */
export const fireRoutine = async (
  db: Db,
  env: Env,
  workspace: WorkspaceRef,
  routine: Routine,
  scheduledFor: Date
): Promise<RoutineRun> => {
  const run = await startRun(db, {
    firedAt: new Date(),
    routineId: routine.id,
    scheduledFor,
  });

  const agent = await getAgentById(db, routine.workspaceId, routine.agentId);
  if (!agent) {
    return await finishRun(db, run.id, {
      error: "The agent this routine mentions no longer exists.",
      status: "error",
    });
  }
  const channel = await getChannel(db, routine.workspaceId, routine.channelId);
  if (!channel) {
    return await finishRun(db, run.id, {
      error: "The channel this routine posts to no longer exists.",
      status: "error",
    });
  }

  try {
    await addChannelMember(db, channel.id, {
      memberId: agent.id,
      memberType: "agent",
    });
    const post = {
      authorId: `${ROUTINE_ORIGIN}:${routine.id}`,
      authorType: "external",
      body: `@${agent.name} ${routine.instructions}`,
      channelId: channel.id,
      origin: ROUTINE_ORIGIN,
      workspace,
    } as const;

    let result: CreateMessageResult;
    if (routine.model === null) {
      result = await publishMessage(db, env, post);
    } else {
      result = await createMessage(db, post);
      if (result.ok) {
        // One run is one thread, so a thread override covers the whole run and
        // every reply under it - and it is written before the router hears
        // about the message at all.
        await upsertOverride(db, {
          agentId: routine.agentId,
          channelId: channel.id,
          createdBy: `${ROUTINE_ORIGIN}:${routine.id}`,
          model: routine.model,
          threadParentId: result.message.id,
          workspaceId: routine.workspaceId,
        });
        await fanOutMessage(db, env, result.message);
      }
    }
    if (!result.ok) {
      return await finishRun(db, run.id, {
        error: result.reason,
        status: "error",
      });
    }
    return await finishRun(db, run.id, {
      messageId: result.message.id,
      status: "posted",
    });
  } catch (error) {
    return await finishRun(db, run.id, {
      error: error instanceof Error ? error.message : "The post failed.",
      status: "error",
    });
  }
};
