// The team diary goes into the team room at 08:00 in the workspace's timezone,
// the first 08:00 after the team dream finished, never at dream time. A diary
// more than 12 hours past its slot is dropped. A diary already in its team's
// "Team diary" topic is not posted again. When a team finished several dreams
// before one slot, only the newest dream's diary is posted.
import type { Database } from "@repo/db";
import { dreamRuns } from "@repo/db/schema/dreams";
import { inboxPosts, inboxThreads } from "@repo/db/schema/inbox";
import { teams } from "@repo/db/schema/teams";
import { workspaces } from "@repo/db/schema/workspaces";
import { and, asc, eq, gte, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import type { InboxService } from "../../inbox.ts";
import { isValidTimeZone, nextFireTime } from "../../routines/cron.ts";
import type { Clock } from "../../runs/types.ts";
import { inBatches } from "../../tasks/reads.ts";
import { TEAM_DIARY_TOPIC } from "./collect.ts";

const DIARY_CRON = "0 8 * * *";
const HOUR_MS = 60 * 60_000;
const LOOKBACK_MS = 48 * HOUR_MS;
const DUE_WINDOW_MS = 12 * HOUR_MS;

export interface TeamDiaryPosterDeps {
  clock: Clock;
  db: Database;
  inbox: Pick<InboxService, "postNotice">;
}

export interface TeamDiaryPostResult {
  /** The dream run ids whose diary was posted by this call. */
  posted: string[];
}

/** A finished team dream with a diary, and what posting it needs. */
interface Candidate {
  diary: string;
  finishedAt: string;
  id: string;
  leadAgentId: string | null;
  teamId: string;
  timezone: string;
}

/** The team dreams that finished in the last 48 hours, oldest first, whose team is live. */
const readCandidates = async (
  db: Database,
  now: Date
): Promise<Candidate[]> => {
  const since = new Date(now.getTime() - LOOKBACK_MS).toISOString();
  const rows = await db
    .select({
      diary: dreamRuns.diary,
      finishedAt: dreamRuns.finishedAt,
      id: dreamRuns.id,
      leadAgentId: teams.leadAgentId,
      teamId: dreamRuns.teamId,
      timezone: workspaces.timezone,
    })
    .from(dreamRuns)
    .innerJoin(teams, eq(teams.id, dreamRuns.teamId))
    .innerJoin(workspaces, eq(workspaces.id, dreamRuns.workspaceId))
    .where(
      and(
        eq(dreamRuns.status, "done"),
        isNotNull(dreamRuns.teamId),
        ne(dreamRuns.diary, ""),
        isNull(teams.archivedAt),
        gte(dreamRuns.finishedAt, since)
      )
    )
    .orderBy(asc(dreamRuns.finishedAt));
  return rows.flatMap((row) =>
    row.teamId && row.finishedAt && row.diary.trim() !== ""
      ? [
          {
            diary: row.diary,
            finishedAt: row.finishedAt,
            id: row.id,
            leadAgentId: row.leadAgentId,
            teamId: row.teamId,
            timezone: row.timezone,
          },
        ]
      : []
  );
};

/** The first 08:00 in the workspace's timezone after the dream finished, or null when the zone is unusable. */
const slotOf = (run: Candidate): number | null =>
  isValidTimeZone(run.timezone)
    ? nextFireTime(DIARY_CRON, run.timezone, new Date(run.finishedAt))
    : null;

const isDue = (slot: number, nowMs: number): boolean =>
  slot <= nowMs && nowMs - slot < DUE_WINDOW_MS;

/** The due runs, one per team and slot: the newest dream's diary stands for the morning. */
const dueRuns = (
  candidates: readonly Candidate[],
  nowMs: number
): Candidate[] => {
  const newest = new Map<string, Candidate>();
  for (const run of candidates) {
    const slot = slotOf(run);
    if (slot !== null && isDue(slot, nowMs)) {
      // Candidates come oldest first, so a later run replaces an earlier one.
      newest.set(`${run.teamId}\n${slot}`, run);
    }
  }
  return [...newest.values()];
};

/** The runs whose diary is already in its team's diary topic: same text, posted after the dream finished. */
const postedRunIds = async (
  db: Database,
  runs: readonly Candidate[]
): Promise<Set<string>> => {
  if (runs.length === 0) {
    return new Set();
  }
  const earliest = runs
    .map((run) => run.finishedAt)
    .reduce((a, b) => (b < a ? b : a));
  // D1 binds at most 100 values per query, so the teams are read in batches.
  const posts = await inBatches(
    runs.map((run) => run.teamId),
    (teamIds) =>
      db
        .select({
          createdAt: inboxPosts.createdAt,
          teamId: inboxThreads.teamId,
          text: inboxPosts.text,
        })
        .from(inboxPosts)
        .innerJoin(inboxThreads, eq(inboxThreads.id, inboxPosts.threadId))
        .where(
          and(
            eq(inboxThreads.title, TEAM_DIARY_TOPIC),
            inArray(inboxThreads.teamId, teamIds),
            gte(inboxPosts.createdAt, earliest)
          )
        )
  );
  return new Set(
    runs
      .filter((run) =>
        posts.some(
          (post) =>
            post.teamId === run.teamId &&
            post.text === run.diary.trim() &&
            post.createdAt >= run.finishedAt
        )
      )
      .map((run) => run.id)
  );
};

/** Posts the diaries that are due. The lead posts each one, or the system when the team has no lead. */
export const createTeamDiaryPoster = (deps: TeamDiaryPosterDeps) => {
  const { clock, db, inbox } = deps;

  const postDue = async (): Promise<TeamDiaryPostResult> => {
    const now = clock.now();
    const due = dueRuns(await readCandidates(db, now), now.getTime());
    const done = await postedRunIds(db, due);
    const posted: string[] = [];
    for (const run of due) {
      if (done.has(run.id)) {
        continue;
      }
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one post at a time, so a failure stays with its own team
        await inbox.postNotice(
          { kind: "system" },
          {
            authorAgentId: run.leadAgentId,
            teamId: run.teamId,
            text: run.diary,
            title: TEAM_DIARY_TOPIC,
          }
        );
        posted.push(run.id);
      } catch {
        // The diary stays due until its window closes, so the next tick tries again.
      }
    }
    return { posted };
  };

  return { postDue };
};
