// The dream trigger: one live `triggers` row of kind `dream` per active agent
// whose dream schedule is not off. The system makes and removes it. A person
// changes the agent's `remember.dreamSchedule` (`memory.rules.set`), and the
// minute tick heals any gap (a new agent, an agent that predates dreams, a
// workspace that changed its timezone), so no agent-creation path needs to
// know about dreams.
import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import type { DreamSchedule } from "@repo/db/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { nextFireTime } from "../routines/cron.ts";

/** 02:00 in the workspace's timezone: every night, or on Sunday. */
export const DREAM_CRONS = {
  nightly: "0 2 * * *",
  weekly: "0 2 * * 0",
} as const satisfies Record<Exclude<DreamSchedule, "off">, string>;

export const DREAM_TRIGGER_NAME = "Dream";
const SYSTEM_CREATOR = "system";
/** Agents the tick repairs in one pass; the next minute takes the rest. */
const SYNC_BATCH = 100;

/** The next 02:00 slot after `after` as an ISO instant, or null when the cron or zone is unusable. */
export const nextDreamSlot = (
  schedule: Exclude<DreamSchedule, "off">,
  timezone: string,
  after: Date
): string | null => {
  try {
    const next = nextFireTime(DREAM_CRONS[schedule], timezone, after);
    return next === null ? null : new Date(next).toISOString();
  } catch {
    return null;
  }
};

const scheduleOf = (remember: string): DreamSchedule => {
  try {
    const { dreamSchedule } = JSON.parse(remember) as {
      dreamSchedule?: unknown;
    };
    return dreamSchedule === "weekly" || dreamSchedule === "off"
      ? dreamSchedule
      : "nightly";
  } catch {
    return "nightly";
  }
};

/** Whether the live trigger of an agent already says what the schedule asks. */
const settled = (
  row: {
    cron: string | null;
    nextRunAt: string | null;
    timezone: string | null;
  } | null,
  schedule: DreamSchedule,
  timezone: string
): boolean => {
  if (schedule === "off") {
    return row === null;
  }
  return (
    row !== null &&
    row.nextRunAt !== null &&
    row.cron === DREAM_CRONS[schedule] &&
    row.timezone === timezone
  );
};

interface Candidate {
  agentId: string;
  remember: string;
  timezone: string;
  trigger: {
    cron: string | null;
    id: string;
    nextRunAt: string | null;
    timezone: string | null;
  } | null;
  workspaceId: string;
}

/** The agent's schedule, nightly when the column holds nothing usable. `json_extract` throws on malformed JSON, so the text is checked first. */
const scheduleSql = sql`coalesce(case when json_valid(${agents.remember}) then json_extract(${agents.remember}, '$.dreamSchedule') end, 'nightly')`;

const liveDream = and(eq(triggers.kind, "dream"), isNull(triggers.revokedAt));

const candidates = async (
  db: Database,
  agentId: string | null
): Promise<Candidate[]> => {
  const rows = await db
    .select({
      agentId: agents.id,
      remember: agents.remember,
      timezone: workspaces.timezone,
      triggerCron: triggers.cron,
      triggerId: triggers.id,
      triggerNext: triggers.nextRunAt,
      triggerTimezone: triggers.timezone,
      workspaceId: agents.workspaceId,
    })
    .from(agents)
    .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
    .leftJoin(triggers, and(eq(triggers.agentId, agents.id), liveDream))
    .where(
      and(
        eq(agents.status, "active"),
        agentId === null ? undefined : eq(agents.id, agentId),
        // Skip what is already right, in SQL, so a quiet minute reads nothing.
        agentId === null
          ? sql`(
              (${triggers.id} is null and ${scheduleSql} <> 'off')
              or (${triggers.id} is not null and (
                ${scheduleSql} = 'off'
                or ${triggers.nextRunAt} is null
                or ${triggers.timezone} is not ${workspaces.timezone}
                or ${triggers.cron} is not case ${scheduleSql} when 'weekly' then ${DREAM_CRONS.weekly} else ${DREAM_CRONS.nightly} end
              ))
            )`
          : undefined
      )
    )
    .limit(SYNC_BATCH);
  return rows.map((row) => ({
    agentId: row.agentId,
    remember: row.remember,
    timezone: row.timezone,
    trigger: row.triggerId
      ? {
          cron: row.triggerCron,
          id: row.triggerId,
          nextRunAt: row.triggerNext,
          timezone: row.triggerTimezone,
        }
      : null,
    workspaceId: row.workspaceId,
  }));
};

const applyOne = async (
  db: Database,
  candidate: Candidate,
  now: Date
): Promise<boolean> => {
  const schedule = scheduleOf(candidate.remember);
  if (settled(candidate.trigger, schedule, candidate.timezone)) {
    return false;
  }
  if (schedule === "off") {
    if (candidate.trigger) {
      await db
        .update(triggers)
        .set({ revokedAt: now.toISOString() })
        .where(eq(triggers.id, candidate.trigger.id));
    }
    return true;
  }
  const nextRunAt = nextDreamSlot(schedule, candidate.timezone, now);
  if (nextRunAt === null) {
    return false;
  }
  const fields = {
    cron: DREAM_CRONS[schedule],
    disabledAt: null,
    nextRunAt,
    timezone: candidate.timezone,
  };
  if (candidate.trigger) {
    await db
      .update(triggers)
      .set(fields)
      .where(eq(triggers.id, candidate.trigger.id));
    return true;
  }
  await db
    .insert(triggers)
    .values({
      ...fields,
      agentId: candidate.agentId,
      approvedAt: now.toISOString(),
      createdAt: now.toISOString(),
      createdBy: SYSTEM_CREATOR,
      id: ulid(),
      kind: "dream",
      name: DREAM_TRIGGER_NAME,
      workspaceId: candidate.workspaceId,
    })
    // Another sync made the agent's one live trigger first.
    .onConflictDoNothing();
  return true;
};

/**
 * Makes the dream trigger match `agents.remember.dreamSchedule`: created when
 * the schedule is nightly or weekly, changed when the schedule or the
 * workspace's timezone changed, revoked when it is off. With an agent id it
 * checks that agent; without, it repairs what is out of step, up to a batch.
 * Draft and archived agents get none. Returns how many triggers it touched.
 */
export const syncDreamTriggers = async (
  db: Database,
  now: Date,
  agentId: string | null = null
): Promise<number> => {
  let touched = 0;
  for (const candidate of await candidates(db, agentId)) {
    // biome-ignore lint/performance/noAwaitInLoops: one agent at a time keeps a failure to that agent
    if (await applyOne(db, candidate, now)) {
      touched += 1;
    }
  }
  return touched;
};
