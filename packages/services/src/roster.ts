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
  type AgentCard,
  DONE_STATUS_PREFIX,
  LIVE_RUN_STATUSES,
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
import { avatarOf } from "./agents.ts";
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
import type { Principal } from "./workspaces.ts";

const ROSTER_READ = "roster.read";
const ROSTER_KIND = "roster";
const JOB_LINE_MAX_CHARS = 80;
export const PAUSED_STATUS_LINE = "Paused. Weekly limit reached";

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
    ? `${chars
        .slice(0, JOB_LINE_MAX_CHARS - 1)
        .join("")
        .trimEnd()}…`
    : chars.join("");
};

type RunFact = Pick<
  typeof runs.$inferSelect,
  "agentId" | "createdAt" | "finishedAt" | "id" | "inputText" | "status"
>;
interface Wait {
  count: number;
  owner: string;
  title: string;
}

// Which map a live run goes in: one per kind of live state, newest first.
const STARTING_STATUSES: readonly RunFact["status"][] = ["queued", "offered"];

const runFacts = (runList: RunFact[]) => {
  const latest = new Map<string, RunFact>();
  const running = new Map<string, RunFact>();
  const waitingRuns = new Map<string, RunFact>();
  const starting = new Map<string, RunFact>();
  for (const run of runList) {
    if (!latest.has(run.agentId)) {
      latest.set(run.agentId, run);
    }
    if (run.status === "running" && !running.has(run.agentId)) {
      running.set(run.agentId, run);
    }
    if (run.status === "waiting" && !waitingRuns.has(run.agentId)) {
      waitingRuns.set(run.agentId, run);
    }
    if (STARTING_STATUSES.includes(run.status) && !starting.has(run.agentId)) {
      starting.set(run.agentId, run);
    }
  }
  return { latest, running, starting, waitingRuns };
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

// A run that is not running yet is working too: queued waits for a slot, an
// offered run waits for its machine to take it.
const activeLine = (active: RunFact, runTitle: string): string => {
  if (active.status === "queued") {
    return "Queued";
  }
  return active.status === "offered" ? "Starting" : runTitle;
};

const activityFor = (input: {
  paused: boolean;
  wait: Wait | undefined;
  waitingOn: string | undefined;
  last: RunFact | undefined;
  active: RunFact | undefined;
  machineStatus: string | null;
  fire: number | undefined;
  runTitle: string;
  lastTitle: string;
  now: Date;
  timeFormat: Intl.DateTimeFormat;
}): Pick<AgentCard, "state" | "statusLine"> & { doneAt?: string } => {
  const {
    paused,
    wait,
    waitingOn,
    last,
    active,
    machineStatus,
    fire,
    runTitle,
    lastTitle,
    now,
    timeFormat,
  } = input;
  // A pause is itself a Needs you wait for the owner, so it is checked first.
  if (paused) {
    return { state: "stopped", statusLine: PAUSED_STATUS_LINE };
  }
  if (wait) {
    return { state: "needs_you", statusLine: wait.title };
  }
  // A run that waits on a person, with no request the rail lists for this
  // viewer, is still waiting. Never read it as idle.
  if (waitingOn !== undefined) {
    return {
      state: "needs_you",
      statusLine: waitingOn ? `Waiting on ${waitingOn}` : "Waiting on a person",
    };
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
    return { state: "working", statusLine: activeLine(active, runTitle) };
  }
  const finishedAt = recentlyFinishedAt(last, now);
  if (finishedAt) {
    // A title that already ends in punctuation, such as a clipped "...", needs no second full stop.
    const joiner = ENDS_IN_PUNCTUATION.test(lastTitle) ? " " : ". ";
    const nextRun =
      fire === undefined ? "" : `${joiner}Next run ${timeFormat.format(fire)}`;
    // The finish time is left out of the line: the browser prints it in the viewer's own zone.
    return {
      doneAt: finishedAt.toISOString(),
      state: "idle",
      statusLine: `${DONE_STATUS_PREFIX}${lastTitle}${nextRun}`,
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
          or(eq(ranked.rank, 1), inArray(ranked.status, [...LIVE_RUN_STATUSES]))
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
      // "everyone" lists every item this viewer may see, not only the viewer's
      // own, so an agent's card reads the same on every member's roster (RH.2:
      // needs_you means an open request that names the agent's owner or backup).
      rail.get(principal, { dayStart: weekStart, scope: "everyone" }),
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
    const { latest, running, starting, waitingRuns } = runFacts(runList);
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
    // A schedule prints in the workspace zone, named, because that is the zone it runs in.
    // Include a date so tomorrow's slot cannot be mistaken for today's.
    const timeFormat = new Intl.DateTimeFormat("en-AU", {
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      month: "short",
      timeZone: timezone,
      timeZoneName: "short",
    });
    return rows.map(({ agent: row, machineStatus }): AgentCard => {
      const wait = waiting.get(row.id);
      const last = latest.get(row.id);
      const active = running.get(row.id) ?? starting.get(row.id);
      const ownerName =
        names.get(assigneeOf(row, null) ?? "") ?? wait?.owner ?? "";
      const home = homeTeams.get(row.id);
      const { doneAt, state, statusLine } = activityFor({
        active,
        fire: next.get(row.id),
        last,
        lastTitle: last
          ? runTitleText(last.inputText, subjectOf.get(last.id))
          : "",
        machineStatus,
        now,
        paused: row.pausedAt !== null,
        runTitle:
          active?.status === "running"
            ? runTitleText(active.inputText, subjectOf.get(active.id))
            : "",
        timeFormat,
        wait,
        waitingOn: waitingRuns.has(row.id) ? ownerName : undefined,
      });
      return {
        avatar: avatarOf(row),
        doneAt: doneAt ?? null,
        id: row.id,
        isLead: home?.isLead ?? false,
        jobLine: jobLineFor(row.instructions),
        learnedCount: learned.get(row.id) ?? 0,
        name: row.name,
        needsYouCount: wait?.count ?? 0,
        ownerName,
        slug: row.slug,
        state,
        statusLine,
        teamId: home?.teamId ?? null,
        weeklyCapCents: row.weeklyCapCents,
      };
    });
  };
  return { list };
};

export type RosterService = ReturnType<typeof createRosterService>;
