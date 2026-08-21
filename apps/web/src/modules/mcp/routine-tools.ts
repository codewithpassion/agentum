import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { AVAILABLE_MODEL_IDS } from "#/modules/anthropic/config";
import { getChannel, listChannels } from "#/modules/messaging/service";
import type { Schedule } from "#/modules/routines/schedule";
import { rescheduleRoutines } from "#/modules/routines/scheduler";
import type { Routine } from "#/modules/routines/schema";
import {
  createRoutine,
  deleteRoutine,
  getRoutine,
  latestRunsFor,
  listRoutines,
  scheduleOf,
  updateRoutine,
} from "#/modules/routines/service";
import {
  type Checked,
  checkModel,
  checkSchedule,
  checkTimezone,
  firstRunAt,
  nextRunAfterChange,
} from "#/modules/routines/validate";
import { fail, json } from "./format";
import type { McpToolContext } from "./tools";

/**
 * An agent's own routines, from the inside. "@agent create a routine that runs
 * weekdays at 5am checking my email" is one tool call, and so is changing it to
 * 6am later.
 *
 * Strictly self-scoped: only rows whose `agentId` is this agent's, and only
 * channels of its own workspace. Somebody else's routine id answers exactly
 * what an id nobody has answers, so these tools cannot be used to find out what
 * other agents are up to.
 *
 * Nothing here re-derives what a valid routine is - `routines/validate.ts` owns
 * that, shared with the HTTP routes - so a refusal the web form would give is
 * the refusal the agent gets, in words it can act on and retry.
 */

const NAME_MAX_LENGTH = 120;
const INSTRUCTIONS_MAX_LENGTH = 10_000;

/** The same answer for another agent's routine and for one that never existed. */
const NO_SUCH_ROUTINE = (routineId: string) =>
  `No routine with id ${routineId}. Use routine_list to see yours.`;

/** What `routine_update` takes to mean "back to my own model". */
const CLEAR_MODEL = "default";

const scheduleSchema = z
  .discriminatedUnion("type", [
    z.object({
      at: z
        .string()
        .describe(
          'Local wall clock, "YYYY-MM-DDTHH:mm", e.g. "2026-09-01T09:00".'
        ),
      type: z.literal("once"),
    }),
    z.object({
      time: z.string().describe('24-hour "HH:mm", e.g. "05:00".'),
      type: z.literal("daily"),
      weekdaysOnly: z
        .boolean()
        .optional()
        .describe("True for Monday to Friday only."),
    }),
    z.object({
      day: z.number().int().describe("0 is Sunday, 6 is Saturday."),
      time: z.string().describe('24-hour "HH:mm".'),
      type: z.literal("weekly"),
    }),
    z.object({
      everyMinutes: z.number().int().describe("Between 15 and 44640."),
      type: z.literal("interval"),
    }),
    z.object({
      expr: z
        .string()
        .describe(
          'Five fields, e.g. "0 9 * * 1-5". No names, macros or L/W/#.'
        ),
      type: z.literal("cron"),
    }),
  ])
  .describe(
    "When it runs. The times are wall clock in the routine's timezone."
  );

const timezoneSchema = z
  .string()
  .describe(
    'IANA zone the times are read in, e.g. "Australia/Sydney". Use the timezone you know the person is in; if you do not know it, ask them with ask_user rather than guessing.'
  );

const modelSchema = z
  .string()
  .describe(
    `The model the routine's run should use, one of: ${AVAILABLE_MODEL_IDS}. Omit to run on whatever model you are configured with.`
  );

// --- reading ------------------------------------------------------------------

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MINUTES_PER_HOUR = 60;

const describeInterval = (everyMinutes: number): string =>
  everyMinutes % MINUTES_PER_HOUR === 0
    ? `every ${everyMinutes / MINUTES_PER_HOUR} hour(s)`
    : `every ${everyMinutes} minutes`;

/**
 * A schedule in a sentence, for an agent to read back to a person. Deliberately
 * plainer than the UI's version in `lib/schedule-format.ts`: this side of the
 * workspace speaks in the routine's own stored terms, and every extra word
 * costs the agent context.
 */
const describeSchedule = (schedule: Schedule | null): string => {
  if (!schedule) {
    return "unreadable schedule";
  }
  switch (schedule.type) {
    case "once":
      return `once, at ${schedule.at}`;
    case "daily":
      return `every ${schedule.weekdaysOnly ? "weekday" : "day"} at ${schedule.time}`;
    case "weekly":
      return `every ${WEEKDAYS[schedule.day] ?? "week"} at ${schedule.time}`;
    case "interval":
      return describeInterval(schedule.everyMinutes);
    case "cron":
      return `cron: ${schedule.expr}`;
    default:
      return "unreadable schedule";
  }
};

const AGENT_DEFAULT = "agent default";

export const routineList = async (
  ctx: McpToolContext
): Promise<CallToolResult> => {
  const mine = (await listRoutines(ctx.db, ctx.workspace.id)).filter(
    (routine) => routine.agentId === ctx.agent.id
  );
  const [channels, lastRuns] = await Promise.all([
    listChannels(ctx.db, ctx.workspace.id),
    latestRunsFor(
      ctx.db,
      mine.map((routine) => routine.id)
    ),
  ]);
  const channelNames = new Map(
    channels.map((channel) => [channel.id, channel.name])
  );

  return json({
    routines: mine.map((routine) => {
      const lastRun = lastRuns.get(routine.id);
      return {
        channelId: routine.channelId,
        channelName: channelNames.get(routine.channelId) ?? null,
        enabled: routine.enabled,
        id: routine.id,
        instructions: routine.instructions,
        lastRun: lastRun
          ? {
              at: lastRun.firedAt.toISOString(),
              error: lastRun.error,
              status: lastRun.status,
            }
          : null,
        model: routine.model ?? AGENT_DEFAULT,
        name: routine.name,
        nextRunAt: routine.nextRunAt?.toISOString() ?? null,
        schedule: describeSchedule(scheduleOf(routine)),
        timezone: routine.timezone,
      };
    }),
  });
};

// --- writing ------------------------------------------------------------------

/** Yours or nothing: a routine of another agent's is never even acknowledged. */
const ownRoutine = async (
  ctx: McpToolContext,
  routineId: string
): Promise<Routine | undefined> => {
  const routine = await getRoutine(ctx.db, ctx.workspace.id, routineId);
  return routine?.agentId === ctx.agent.id ? routine : undefined;
};

/**
 * The first thing a refusal has to survive is being read by a model, so the
 * reason travels out as tool text rather than as a thrown status.
 */
class RefusedError extends Error {}

const required = <T>(checked: Checked<T>): T => {
  if (!checked.ok) {
    throw new RefusedError(checked.reason);
  }
  return checked.value;
};

const refusals = async (
  work: () => Promise<CallToolResult>
): Promise<CallToolResult> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof RefusedError) {
      return fail(error.message);
    }
    throw error;
  }
};

const requireOwnChannel = async (
  ctx: McpToolContext,
  channelId: string
): Promise<string> => {
  if (!(await getChannel(ctx.db, ctx.workspace.id, channelId))) {
    throw new RefusedError(
      `No channel with id ${channelId}. Use list_channels to see them.`
    );
  }
  return channelId;
};

/** `"default"` clears; anything else has to be a catalog id. */
const requireModel = (model: string | undefined): string | null | undefined => {
  if (model === undefined) {
    return;
  }
  return required(checkModel(model === CLEAR_MODEL ? null : model));
};

export interface RoutineCreateArgs {
  channelId: string;
  instructions: string;
  model?: string;
  name: string;
  schedule: Schedule;
  timezone: string;
}

export const routineCreate = (
  ctx: McpToolContext,
  args: RoutineCreateArgs
): Promise<CallToolResult> =>
  refusals(async () => {
    const channelId = await requireOwnChannel(ctx, args.channelId);
    const schedule = required(checkSchedule(args.schedule));
    const timezone = required(checkTimezone(args.timezone));
    const nextRunAt = required(firstRunAt(schedule, timezone));

    const routine = await createRoutine(ctx.db, ctx.workspace.id, {
      agentId: ctx.agent.id,
      channelId,
      instructions: args.instructions,
      model: requireModel(args.model) ?? null,
      name: args.name,
      nextRunAt,
      schedule,
      timezone,
    });
    await rescheduleRoutines(ctx.env, ctx.workspace.id);

    return json({
      id: routine.id,
      model: routine.model ?? AGENT_DEFAULT,
      name: routine.name,
      nextRunAt: nextRunAt.toISOString(),
      schedule: describeSchedule(schedule),
      timezone,
    });
  });

export interface RoutineUpdateArgs {
  channelId?: string;
  enabled?: boolean;
  instructions?: string;
  model?: string;
  name?: string;
  routineId: string;
  schedule?: Schedule;
  timezone?: string;
}

export const routineUpdate = (
  ctx: McpToolContext,
  args: RoutineUpdateArgs
): Promise<CallToolResult> =>
  refusals(async () => {
    const routine = await ownRoutine(ctx, args.routineId);
    if (!routine) {
      return fail(NO_SUCH_ROUTINE(args.routineId));
    }

    const channelId =
      args.channelId === undefined
        ? undefined
        : await requireOwnChannel(ctx, args.channelId);
    const schedule =
      args.schedule === undefined
        ? undefined
        : required(checkSchedule(args.schedule));
    const timezone =
      args.timezone === undefined
        ? undefined
        : required(checkTimezone(args.timezone));
    const nextRunAt = required(
      nextRunAfterChange(routine, { enabled: args.enabled, schedule, timezone })
    );

    const updated = await updateRoutine(ctx.db, ctx.workspace.id, routine.id, {
      channelId,
      enabled: args.enabled,
      instructions: args.instructions,
      model: requireModel(args.model),
      name: args.name,
      nextRunAt,
      schedule,
      timezone,
    });
    if (!updated) {
      return fail(NO_SUCH_ROUTINE(args.routineId));
    }
    await rescheduleRoutines(ctx.env, ctx.workspace.id);

    return json({
      enabled: updated.enabled,
      id: updated.id,
      model: updated.model ?? AGENT_DEFAULT,
      name: updated.name,
      nextRunAt: updated.nextRunAt?.toISOString() ?? null,
      schedule: describeSchedule(scheduleOf(updated)),
      timezone: updated.timezone,
    });
  });

export const routineDelete = async (
  ctx: McpToolContext,
  args: { routineId: string }
): Promise<CallToolResult> => {
  const routine = await ownRoutine(ctx, args.routineId);
  if (!routine) {
    return fail(NO_SUCH_ROUTINE(args.routineId));
  }
  await deleteRoutine(ctx.db, ctx.workspace.id, routine.id);
  await rescheduleRoutines(ctx.env, ctx.workspace.id);
  return json({ deleted: true, name: routine.name });
};

// --- registration -------------------------------------------------------------

const ROUTINES_INTRO =
  "A routine is a standing instruction to yourself on a schedule: when it fires, its instructions are posted in a channel as if someone had asked you, and you answer in the thread.";

export const registerRoutineTools = (
  server: McpServer,
  ctx: McpToolContext
): void => {
  server.registerTool(
    "routine_list",
    {
      description: `${ROUTINES_INTRO} List your own routines - what each one does, when it next runs, and how the last run went. This is the answer to "what routines are set up?", and where you find the id to change or delete one.`,
      inputSchema: {},
      title: "List your routines",
    },
    () => routineList(ctx)
  );

  server.registerTool(
    "routine_create",
    {
      description: `${ROUTINES_INTRO} Set one up for yourself when someone asks for something to happen regularly ("check my email every weekday at 5am and give me a rundown"). Write the instructions as if briefing yourself: the wake gives you nothing but them. The timezone is required - use the one you know the person is in, and ask with ask_user if you do not know it.`,
      inputSchema: {
        channelId: z
          .string()
          .describe("Where the run posts - usually where you were asked."),
        instructions: z
          .string()
          .min(1)
          .max(INSTRUCTIONS_MAX_LENGTH)
          .describe("What to do each time, in full. You will read this cold."),
        model: modelSchema.optional(),
        name: z
          .string()
          .min(1)
          .max(NAME_MAX_LENGTH)
          .describe('Short and recognisable, e.g. "Morning email rundown".'),
        schedule: scheduleSchema,
        timezone: timezoneSchema,
      },
      title: "Create a routine",
    },
    (args) => routineCreate(ctx, args)
  );

  server.registerTool(
    "routine_update",
    {
      description: `${ROUTINES_INTRO} Change one of your own routines - "move the 5am check to 6am" is a schedule change on the routine routine_list named. Send only the fields that change; everything else stays. Set enabled to false to pause one without losing it, and pass "${CLEAR_MODEL}" as the model to put it back on your own model.`,
      inputSchema: {
        channelId: z.string().optional(),
        enabled: z.boolean().optional().describe("False pauses the routine."),
        instructions: z.string().min(1).max(INSTRUCTIONS_MAX_LENGTH).optional(),
        model: modelSchema.optional(),
        name: z.string().min(1).max(NAME_MAX_LENGTH).optional(),
        routineId: z.string().describe("From routine_list."),
        schedule: scheduleSchema.optional(),
        timezone: timezoneSchema.optional(),
      },
      title: "Change a routine",
    },
    (args) => routineUpdate(ctx, args)
  );

  server.registerTool(
    "routine_delete",
    {
      description: `${ROUTINES_INTRO} Delete one of your own routines, with its run history. There is no undo, so when it is ambiguous which routine is meant, confirm before deleting - pausing it with routine_update is the reversible option.`,
      inputSchema: { routineId: z.string().describe("From routine_list.") },
      title: "Delete a routine",
    },
    (args) => routineDelete(ctx, args)
  );
};
