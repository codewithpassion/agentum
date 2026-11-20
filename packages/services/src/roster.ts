import type { Database } from "@repo/db";
import { agents } from "@repo/db/schema/agents";
import { machines } from "@repo/db/schema/machines";
import { memoryChanges } from "@repo/db/schema/memory";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  AGENT_AVATAR_COLORS,
  type AgentAvatar,
  type AgentCard,
  defaultAgentAvatar,
  type RailView,
} from "@repo/db/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { readableWorkspace } from "./guards.ts";
import { mailSubjectsOf } from "./mail-subjects.ts";
import { runTitleText } from "./mail-title-text.ts";
import type { MembersService } from "./members.ts";
import { assigneeOf, MAIL_BOUNCED_STATUS } from "./rail/logic.ts";
import type { RailService } from "./rail.ts";
import { nextFireTime } from "./routines/cron.ts";
import type { Clock } from "./runs/types.ts";
import { visibleSessions } from "./sessions.ts";
import { costOf } from "./usage-cost.ts";
import type { Principal } from "./workspaces.ts";

const ROSTER_READ = "roster.read";
const ROSTER_KIND = "roster";
const JOB_LINE_MAX_CHARS = 80;
export const PAUSED_STATUS_LINE = "Paused. Weekly limit reached";

type AgentRow = typeof agents.$inferSelect;

const storedAvatarSchema = z.object({
  color: z.enum(AGENT_AVATAR_COLORS),
  glyph: z.string().min(1),
});

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const avatarFor = (row: AgentRow): AgentAvatar => {
  const parsed = storedAvatarSchema.safeParse(parseJson(row.avatar));
  return parsed.success ? parsed.data : defaultAgentAvatar(row.name);
};

// A sentence ends at punctuation (and a closing quote or bracket) followed by
// whitespace/end; collapse line breaks within it. Clip by Unicode code points so
// a glyph is never cut in half, and end a clipped line with an ellipsis.
const SENTENCE_END = /(?<=[.!?]["'”’)]?)(?:\s|$)/u;
const WHITESPACE = /\s+/g;
const ENDS_IN_PUNCTUATION = /[.!?…]$/u;
const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
export const jobLineFor = (instructions: string): string => {
  const chars = Array.from(
    instructions.trim().split(SENTENCE_END)[0]?.replace(WHITESPACE, " ") ?? ""
  );
  return chars.length > JOB_LINE_MAX_CHARS
    ? `${chars.slice(0, JOB_LINE_MAX_CHARS - 1).join("")}…`
    : chars.join("");
};

type RunFact = Pick<
  typeof runs.$inferSelect,
  | "agentId"
  | "createdAt"
  | "finishedAt"
  | "id"
  | "inputText"
  | "status"
  | "usage"
>;
interface Wait {
  count: number;
  owner: string;
  title: string;
}

const runFacts = (runList: RunFact[], weekStart: string) => {
  const latest = new Map<string, RunFact>();
  const running = new Map<string, RunFact>();
  const costs = new Map<string, number>();
  for (const run of runList) {
    if (!latest.has(run.agentId)) {
      latest.set(run.agentId, run);
    }
    if (run.status === "running" && !running.has(run.agentId)) {
      running.set(run.agentId, run);
    }
    if (run.createdAt >= weekStart) {
      costs.set(run.agentId, (costs.get(run.agentId) ?? 0) + costOf(run.usage));
    }
  }
  return { costs, latest, running };
};

interface HomeTeam {
  isLead: boolean;
  teamId: string;
}

// Rows arrive ordered by team id, so the first home team per agent is the lowest.
const homeTeamsFor = (
  rows: { agentId: string; leadAgentId: string | null; teamId: string }[]
): Map<string, HomeTeam> => {
  const homes = new Map<string, HomeTeam>();
  for (const row of rows) {
    if (!homes.has(row.agentId)) {
      homes.set(row.agentId, {
        isLead: row.leadAgentId === row.agentId,
        teamId: row.teamId,
      });
    }
  }
  return homes;
};

const waitingFacts = (view: RailView): Map<string, Wait> => {
  const waiting = new Map<string, Wait>();
  for (const item of view.needsYou) {
    for (const card of item.cards) {
      // A failed or interrupted run is "stopped". Bounced mail has no run
      // state to show, so it stays a Needs you item as in the rail.
      if (card.kind === "problem" && card.status !== MAIL_BOUNCED_STATUS) {
        continue;
      }
      const seen = waiting.get(card.agentId);
      waiting.set(card.agentId, {
        count: (seen?.count ?? 0) + 1,
        owner: item.assigneeName ?? "",
        title: seen?.title ?? card.title,
      });
    }
  }
  return waiting;
};

const nextRuns = (
  routines: {
    agentId: string;
    cron: string | null;
    timezone: string | null;
  }[],
  timezone: string,
  now: Date
) => {
  const next = new Map<string, number>();
  for (const routine of routines) {
    if (!routine.cron) {
      continue;
    }
    // A routine's cron is read in its own zone, else the workspace's.
    const fire = nextFireTime(routine.cron, routine.timezone || timezone, now);
    if (
      fire !== null &&
      fire < (next.get(routine.agentId) ?? Number.POSITIVE_INFINITY)
    ) {
      next.set(routine.agentId, fire);
    }
  }
  return next;
};

// The finish time of the latest run, while it is done and under a day old.
const recentlyFinishedAt = (
  last: RunFact | undefined,
  now: Date
): Date | undefined => {
  if (last?.status !== "done" || !last.finishedAt) {
    return;
  }
  const finishedAt = new Date(last.finishedAt);
  return now.getTime() - finishedAt.getTime() < DAY_MS ? finishedAt : undefined;
};

const activityFor = (input: {
  paused: boolean;
  wait: Wait | undefined;
  last: RunFact | undefined;
  active: RunFact | undefined;
  machineStatus: string | null;
  fire: number | undefined;
  runTitle: string;
  lastTitle: string;
  now: Date;
  timeFormat: Intl.DateTimeFormat;
  clockFormat: Intl.DateTimeFormat;
}): Pick<AgentCard, "state" | "statusLine"> => {
  const {
    paused,
    wait,
    last,
    active,
    machineStatus,
    fire,
    runTitle,
    lastTitle,
    now,
    timeFormat,
    clockFormat,
  } = input;
  // A pause is itself a Needs you wait for the owner, so it is checked first.
  if (paused) {
    return { state: "stopped", statusLine: PAUSED_STATUS_LINE };
  }
  if (wait) {
    return { state: "needs_you", statusLine: wait.title };
  }
  // No stopped wording is specified; name the reason in plain words.
  // Machines call their archived state "revoked" in the existing schema.
  if (machineStatus === "revoked") {
    return { state: "stopped", statusLine: "Machine archived" };
  }
  if (last?.status === "failed") {
    return { state: "stopped", statusLine: "Failed" };
  }
  if (last?.status === "interrupted") {
    return { state: "stopped", statusLine: "Stopped part way" };
  }
  if (active) {
    return { state: "working", statusLine: runTitle };
  }
  const finishedAt = recentlyFinishedAt(last, now);
  if (finishedAt) {
    // A title that already ends in punctuation, such as a clipped "...", needs no second full stop.
    const joiner = ENDS_IN_PUNCTUATION.test(lastTitle) ? " " : ". ";
    const nextRun =
      fire === undefined ? "" : `${joiner}Next run ${timeFormat.format(fire)}`;
    return {
      state: "idle",
      statusLine: `Done ${clockFormat.format(finishedAt)}: ${lastTitle}${nextRun}`,
    };
  }
  return {
    state: "idle",
    statusLine:
      fire === undefined ? "Idle" : `Idle. Next run ${timeFormat.format(fire)}`,
  };
};

export const createRosterService = ({
  db,
  rail,
  clock,
  members,
}: {
  db: Database;
  rail: Pick<RailService, "get">;
  clock: Pick<Clock, "now">;
  members?: Pick<MembersService, "list">;
}) => {
  const list = async (principal: Principal): Promise<AgentCard[]> => {
    const workspaceId = readableWorkspace(principal, ROSTER_READ);
    authorize(principal, ROSTER_READ, { kind: ROSTER_KIND, workspaceId });
    if (principal.kind !== "user") {
      throw new ForbiddenError(ROSTER_READ);
    }
    const now = clock.now();
    // Match the Agents overview: "this week" is a rolling seven days.
    const weekStart = new Date(now.getTime() - WEEK_MS).toISOString();
    const visible = await visibleSessions(db, principal, now.toISOString());
    const ranked = db
      .select({
        agentId: runs.agentId,
        createdAt: runs.createdAt,
        finishedAt: runs.finishedAt,
        id: runs.id,
        inputText: runs.inputText,
        rank: sql<number>`row_number() over (partition by ${runs.agentId} order by ${runs.createdAt} desc, ${runs.id} desc)`.as(
          "rank"
        ),
        status: runs.status,
        usage: runs.usage,
      })
      .from(runs)
      .where(
        and(
          eq(runs.workspaceId, workspaceId),
          eq(runs.dryRun, false),
          inArray(
            runs.sessionId,
            db.select({ id: sessions.id }).from(sessions).where(visible)
          )
        )
      )
      .as("ranked");
    const [
      rows,
      runList,
      routines,
      workspace,
      view,
      directory,
      homeRows,
      learnedRows,
    ] = await Promise.all([
      // Keep the same active-only visibility and ordering as agents.list.
      db
        .select({ agent: agents, machineStatus: machines.status })
        .from(agents)
        .leftJoin(
          machines,
          and(
            eq(machines.id, agents.machineId),
            eq(machines.workspaceId, workspaceId)
          )
        )
        .where(
          and(eq(agents.workspaceId, workspaceId), eq(agents.status, "active"))
        )
        .orderBy(asc(agents.name), asc(agents.id)),
      db
        .select()
        .from(ranked)
        .where(
          or(
            eq(ranked.rank, 1),
            eq(ranked.status, "running"),
            sql`${ranked.createdAt} >= ${weekStart}`
          )
        )
        .orderBy(desc(ranked.createdAt), desc(ranked.id)),
      db
        .select({
          agentId: triggers.agentId,
          cron: triggers.cron,
          timezone: triggers.timezone,
        })
        .from(triggers)
        .where(
          and(
            eq(triggers.workspaceId, workspaceId),
            eq(triggers.kind, "routine"),
            isNull(triggers.disabledAt),
            isNull(triggers.revokedAt)
          )
        ),
      db
        .select({ timezone: workspaces.timezone })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId)),
      // Use the rail's owner/creator, backup escalation, private-session rules,
      // grouping and plainTitle logic. Problems are stopped, not open waits.
      rail.get(principal, { dayStart: weekStart, scope: "mine" }),
      members ? members.list(principal).catch(() => null) : null,
      db
        .select({
          agentId: teamMembers.memberId,
          leadAgentId: teams.leadAgentId,
          teamId: teams.id,
        })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId))
        .where(
          and(
            eq(teams.workspaceId, workspaceId),
            eq(teamMembers.memberKind, "agent"),
            eq(teamMembers.isHome, true),
            isNull(teams.archivedAt)
          )
        )
        .orderBy(asc(teams.id)),
      // Count change rows by creation time, as memory history does, including
      // all applied actions/writers; private changes stay with their person.
      db
        .select({ agentId: memoryChanges.agentId, count: count() })
        .from(memoryChanges)
        .where(
          and(
            eq(memoryChanges.workspaceId, workspaceId),
            eq(memoryChanges.status, "applied"),
            gte(memoryChanges.createdAt, weekStart),
            or(
              isNull(memoryChanges.userScope),
              eq(memoryChanges.userScope, principal.userId)
            )
          )
        )
        .groupBy(memoryChanges.agentId),
    ]);
    const homeTeams = homeTeamsFor(homeRows);
    const learned = new Map(learnedRows.map((row) => [row.agentId, row.count]));
    const names = new Map(
      directory?.map((entry) => [entry.userId, entry.name])
    );
    const { latest, running, costs } = runFacts(runList, weekStart);
    // A run started by mail is titled by its mail's subject, as on the desk.
    // A latest run that is still shown as done is titled the same way.
    const doneRecently = [...latest.values()].filter(
      (run) => recentlyFinishedAt(run, now) !== undefined
    );
    const subjectOf = await mailSubjectsOf(
      db,
      workspaceId,
      [...running.values(), ...doneRecently].map((run) => run.id)
    );
    const waiting = waitingFacts(view);
    const timezone = workspace[0]?.timezone ?? "UTC";
    const next = nextRuns(routines, timezone, now);
    // Include a date so tomorrow's slot cannot be mistaken for today's.
    const timeFormat = new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      timeZone: timezone,
    });
    const clockFormat = new Intl.DateTimeFormat("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: timezone,
    });
    return rows.map(({ agent: row, machineStatus }): AgentCard => {
      const wait = waiting.get(row.id);
      const last = latest.get(row.id);
      const active = running.get(row.id);
      const home = homeTeams.get(row.id);
      return {
        avatar: avatarFor(row),
        costThisWeekCents: Math.round((costs.get(row.id) ?? 0) * 100),
        id: row.id,
        isLead: home?.isLead ?? false,
        jobLine: jobLineFor(row.instructions),
        learnedCount: learned.get(row.id) ?? 0,
        name: row.name,
        needsYouCount: wait?.count ?? 0,
        ownerName: names.get(assigneeOf(row, null) ?? "") ?? wait?.owner ?? "",
        slug: row.slug,
        ...activityFor({
          active,
          clockFormat,
          fire: next.get(row.id),
          last,
          lastTitle: last
            ? runTitleText(last.inputText, subjectOf.get(last.id))
            : "",
          machineStatus,
          now,
          paused: row.pausedAt !== null,
          runTitle: active
            ? runTitleText(active.inputText, subjectOf.get(active.id))
            : "",
          timeFormat,
          wait,
        }),
        teamId: home?.teamId ?? null,
        weeklyCapCents: row.weeklyCapCents,
      };
    });
  };
  return { list };
};

export type RosterService = ReturnType<typeof createRosterService>;
