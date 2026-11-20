import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { dreamQuestions, dreamRuns } from "@repo/db/schema/dreams";
import { memoryChanges } from "@repo/db/schema/memory";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  DREAM_DECISIONS,
  type DreamQuestion,
  type DreamRun,
  type MemoryChange,
} from "@repo/db/shared";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  ne,
  or,
} from "drizzle-orm";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { isReadOnly } from "./automation-access.ts";
import type { Fetcher } from "./connectors/mcp.ts";
import { heldCounts, openQuestionCounts } from "./dream/held.ts";
import { readOptions } from "./dream/question-options.ts";
import {
  loadDreamAgent,
  type QuestionRow,
  type RunRow,
  toQuestion,
  toRun,
} from "./dream/rows.ts";
import { createDreamRunner } from "./dream/run.ts";
import { createTeamAnswer } from "./dream/team/answer.ts";
import { createTeamDreamRunner } from "./dream/team/run.ts";
import { loadTeamRecord } from "./dream/team/team.ts";
import { createTeamUndo } from "./dream/team/undo.ts";
import {
  DREAM_CRONS,
  nextDreamSlot,
  syncDreamTriggers,
} from "./dream/trigger.ts";
import { createDreamUndo } from "./dream/undo.ts";
import { isServiceError, notFound, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import {
  readableWorkspace,
  requireAgentOwnerOrAdmin,
  requireSession,
} from "./guards.ts";
import type { InboxService } from "./inbox.ts";
import type { ManagedKeysService } from "./managed/keys.ts";
import type { DreamMemoryLibrary } from "./memory/files.ts";
import type { MemoryService } from "./memory/service.ts";
import { toChange } from "./memory/service.ts";
import type { Clock } from "./runs/types.ts";
import { idString } from "./shared.ts";
import type { SkillsStoreService } from "./skills-store.ts";
import type { Principal } from "./workspaces.ts";

const DREAM_READ = "dream.read";
const DREAM_WRITE = "dream.write";
const DREAM_FIRE = "dream.fire";
const DREAM_KIND = "dream";
const RUNS_LIMIT = 50;
/**
 * Dreams one tick starts. A dream takes seconds of model time, and every agent
 * is due at 02:00, so a tick takes a few and the next minutes take the rest.
 */
export const DREAMS_PER_TICK = 5;
/** Team dreams one tick starts. */
export const TEAM_DREAMS_PER_TICK = 3;

export const dreamAgentInputSchema = z.strictObject({ agentId: idString });

export const dreamTeamInputSchema = z.strictObject({ teamId: idString });

export const dreamRunIdInputSchema = z.strictObject({ dreamRunId: idString });

/** The option kept: one of the question's `options`, by note id. */
export const dreamAnswerInputSchema = z.strictObject({
  noteId: idString,
  questionId: idString,
});

/** Approves or rejects every change of a dream that the `ask_first` learn level held. */
export const dreamDecideInputSchema = z.strictObject({
  decision: z.enum(DREAM_DECISIONS),
  dreamRunId: idString,
});

export type DreamAgentInput = z.input<typeof dreamAgentInputSchema>;
export type DreamTeamInput = z.input<typeof dreamTeamInputSchema>;
export type DreamRunIdInput = z.input<typeof dreamRunIdInputSchema>;
export type DreamAnswerInput = z.input<typeof dreamAnswerInputSchema>;
export type DreamDecideInput = z.input<typeof dreamDecideInputSchema>;

export interface DreamDeps {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: Pick<EventsService, "readPayload">;
  /** The same fetch the agent builder calls Anthropic with. */
  fetch: Fetcher;
  /** The team diary is posted in the team room through this. */
  inbox: Pick<InboxService, "postNotice">;
  library: DreamMemoryLibrary;
  managedKeys: Pick<ManagedKeysService, "resolve">;
  /** A person's answer to a question forgets the notes it did not keep, as that person. */
  memory: Pick<MemoryService, "forget">;
  skillsStore: Pick<SkillsStoreService, "list" | "proposeForAgent">;
  /** A team dream's cost counts toward the workspace's weekly cap: it asks before it runs and tells after. */
  spend?: {
    enforceWorkspaceCap: (workspaceId: string) => Promise<void>;
    workspaceOver: (workspaceId: string) => Promise<boolean>;
  };
}

/** What one `fireDueTeams` call did. */
export interface TeamDreamFireResult {
  failed: { message: string; teamId: string }[];
  fired: string[];
  /** Teams that could not start now (a dream already running, the workspace at its limit). They do not use the tick's budget. */
  skipped: { message: string; teamId: string }[];
}

/** What one `fireDue` call did. Run ids, and the agents whose dream could not start. */
export interface DreamFireResult {
  failed: { agentId: string; message: string }[];
  fired: string[];
}

const dreamResource = (workspaceId: string, id?: string) => ({
  id,
  kind: DREAM_KIND,
  workspaceId,
});

const noDreamRun = (dreamRunId: string) =>
  notFound(`No dream run "${dreamRunId}"`);

export const createDreamService = (deps: DreamDeps) => {
  const { atomic, clock, db } = deps;
  const runner = createDreamRunner(deps);
  const undoer = createDreamUndo(deps);
  const teamRunner = createTeamDreamRunner(deps);
  const teamUndoer = createTeamUndo(deps);
  const teamAnswerer = createTeamAnswer(deps);

  const runIn = async (workspaceId: string, id: string): Promise<RunRow> => {
    const [row] = await db
      .select()
      .from(dreamRuns)
      .where(and(eq(dreamRuns.id, id), eq(dreamRuns.workspaceId, workspaceId)))
      .limit(1);
    if (!row) {
      throw noDreamRun(id);
    }
    return row;
  };

  /** The dreams as the contract type, each with the changes it still holds and the questions still open. */
  const withHeld = async (rows: readonly RunRow[]): Promise<DreamRun[]> => {
    const ids = rows.map((row) => row.id);
    const [held, open] = await Promise.all([
      heldCounts(db, ids),
      openQuestionCounts(db, ids),
    ]);
    return rows.map((row) =>
      toRun(row, held.get(row.id) ?? 0, open.get(row.id) ?? 0)
    );
  };

  const oneWithHeld = async (row: RunRow): Promise<DreamRun> => {
    const [run] = await withHeld([row]);
    return run as DreamRun;
  };

  /** The owner or an org admin, on a browser session: who may start, undo or decide a dream. */
  const ownerSession = async (
    principal: Principal,
    workspaceId: string,
    agentId: string
  ) => {
    const user = requireSession(principal, DREAM_WRITE);
    const agent = await loadDreamAgent(db, agentId, workspaceId);
    requireAgentOwnerOrAdmin(
      user,
      { createdBy: agent.createdBy, ownerUserId: agent.ownerUserId },
      DREAM_WRITE
    );
    return { agent, user };
  };

  /** The team's owner or an org admin, on a browser session: who may start, undo or answer for a team dream. */
  const teamOwnerSession = async (
    principal: Principal,
    workspaceId: string,
    teamId: string
  ) => {
    const user = requireSession(principal, DREAM_WRITE);
    const team = await loadTeamRecord(db, teamId, workspaceId);
    if (user.isAdmin !== true && team.ownerUserId !== user.userId) {
      throw new ForbiddenError(DREAM_WRITE);
    }
    return { team, user };
  };

  const list = async (
    principal: Principal,
    agentId: string
  ): Promise<DreamRun[]> => {
    const workspaceId = readableWorkspace(principal, DREAM_READ);
    authorize(principal, DREAM_READ, dreamResource(workspaceId, agentId));
    const rows = await db
      .select()
      .from(dreamRuns)
      .where(
        and(
          eq(dreamRuns.workspaceId, workspaceId),
          eq(dreamRuns.agentId, agentId)
        )
      )
      .orderBy(desc(dreamRuns.startedAt), desc(dreamRuns.id))
      .limit(RUNS_LIMIT);
    return await withHeld(rows);
  };

  const get = async (
    principal: Principal,
    dreamRunId: string
  ): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_READ);
    authorize(principal, DREAM_READ, dreamResource(workspaceId, dreamRunId));
    return await oneWithHeld(await runIn(workspaceId, dreamRunId));
  };

  /** Starts a dream of the agent now. A dream that fails is a `failed` run, returned like any other. */
  const runNow = async (
    principal: Principal,
    agentId: string
  ): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(principal, DREAM_WRITE, dreamResource(workspaceId, agentId));
    const { agent } = await ownerSession(principal, workspaceId, agentId);
    const run = await runner.run(agent.id);
    return await oneWithHeld(await runIn(workspaceId, run.id));
  };

  /** Starts a dream of the team now, as the team's owner or an org admin. */
  const runTeamNow = async (
    principal: Principal,
    teamId: string
  ): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(principal, DREAM_WRITE, dreamResource(workspaceId, teamId));
    await teamOwnerSession(principal, workspaceId, teamId);
    const run = await teamRunner.run(teamId, workspaceId);
    return await oneWithHeld(await runIn(workspaceId, run.id));
  };

  /** Puts every memory file the dream wrote back as it was, and marks its changes undone. */
  const undo = async (
    principal: Principal,
    dreamRunId: string
  ): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(principal, DREAM_WRITE, dreamResource(workspaceId, dreamRunId));
    const run = await runIn(workspaceId, dreamRunId);
    if (run.agentId === null) {
      const { team, user } = await teamOwnerSession(
        principal,
        workspaceId,
        run.teamId ?? ""
      );
      await teamUndoer.undo(run, team, user.userId);
      return await oneWithHeld(await runIn(workspaceId, dreamRunId));
    }
    const { agent, user } = await ownerSession(
      principal,
      workspaceId,
      run.agentId
    );
    await undoer.undo(run, agent, user.userId);
    return await oneWithHeld(await runIn(workspaceId, dreamRunId));
  };

  /** The `memory_changes` rows one dream wrote, held or applied. A person's private notes show to that person only. */
  const changes = async (
    principal: Principal,
    dreamRunId: string
  ): Promise<MemoryChange[]> => {
    const workspaceId = readableWorkspace(principal, DREAM_READ);
    authorize(principal, DREAM_READ, dreamResource(workspaceId, dreamRunId));
    await runIn(workspaceId, dreamRunId);
    const userId = principal.kind === "user" ? principal.userId : null;
    const rows = await db
      .select()
      .from(memoryChanges)
      .where(
        and(
          eq(memoryChanges.workspaceId, workspaceId),
          eq(memoryChanges.dreamRunId, dreamRunId),
          userId === null
            ? isNull(memoryChanges.userScope)
            : or(
                isNull(memoryChanges.userScope),
                eq(memoryChanges.userScope, userId)
              )
        )
      )
      .orderBy(asc(memoryChanges.id));
    return rows.map(toChange);
  };

  /**
   * Approves or rejects every change a dream held, together. `memory.decide`
   * refuses a dream's rows, so a dream's changes are never decided one by one.
   */
  const decide = async (
    principal: Principal,
    input: DreamDecideInput
  ): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(
      principal,
      DREAM_WRITE,
      dreamResource(workspaceId, input.dreamRunId)
    );
    const run = await runIn(workspaceId, input.dreamRunId);
    if (run.agentId === null) {
      throw new ServiceError(
        "invalid",
        "A team dream applies at once, so it holds nothing to approve"
      );
    }
    const { agent, user } = await ownerSession(
      principal,
      workspaceId,
      run.agentId
    );
    await undoer.decide(run, agent, user.userId, input.decision);
    return await oneWithHeld(await runIn(workspaceId, input.dreamRunId));
  };

  const openQuestion = async (
    workspaceId: string,
    questionId: string,
    userId: string
  ): Promise<{ row: QuestionRow; keep: string[] }> => {
    const [row] = await db
      .select()
      .from(dreamQuestions)
      .where(
        and(
          eq(dreamQuestions.id, questionId),
          eq(dreamQuestions.workspaceId, workspaceId)
        )
      )
      .limit(1);
    const stored = row ? readOptions(row.options) : null;
    // Another person's private question reads as missing.
    if (
      !(row && stored) ||
      (stored.userScope !== null && stored.userScope !== userId)
    ) {
      throw notFound(`No question "${questionId}"`);
    }
    return { keep: stored.options.map((option) => option.noteId), row };
  };

  /** The question as it is now. */
  const reread = async (row: QuestionRow): Promise<DreamQuestion> => {
    const [current] = await db
      .select()
      .from(dreamQuestions)
      .where(eq(dreamQuestions.id, row.id))
      .limit(1);
    return toQuestion(current ?? row);
  };

  /** A team's question is the team owner's to answer, and updates every member that disagreed. */
  const answerTeam = async (
    principal: Extract<Principal, { kind: "user" }>,
    workspaceId: string,
    row: QuestionRow,
    noteId: string
  ): Promise<DreamQuestion> => {
    await teamOwnerSession(principal, workspaceId, row.teamId ?? "");
    await teamAnswerer.answer(principal, row, noteId);
    return await reread(row);
  };

  /** Keeps the chosen note, forgets the others as the person who answered, and closes the question. The owner, the backup owner or an org admin may answer. Anyone else is refused for shared notes by `memory.forget`. */
  const answer = async (
    principal: Principal,
    input: DreamAnswerInput
  ): Promise<DreamQuestion> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(
      principal,
      DREAM_WRITE,
      dreamResource(workspaceId, input.questionId)
    );
    if (principal.kind !== "user" || isReadOnly(principal)) {
      throw new ForbiddenError(DREAM_WRITE);
    }
    const { row, keep } = await openQuestion(
      workspaceId,
      input.questionId,
      principal.userId
    );
    if (row.status !== "open") {
      throw new ServiceError("conflict", "That question is already answered");
    }
    if (!keep.includes(input.noteId)) {
      throw new ServiceError("invalid", "Choose one of the notes asked about");
    }
    if (row.agentId === null) {
      return await answerTeam(principal, workspaceId, row, input.noteId);
    }
    for (const noteId of keep.filter((id) => id !== input.noteId)) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one note at a time, so a failure leaves the question open
        await deps.memory.forget(
          principal,
          { agentId: row.agentId, noteId },
          { asDecision: true }
        );
      } catch (error) {
        // Forgotten already, by an earlier try of this same answer.
        if (!(isServiceError(error) && error.code === "not_found")) {
          throw error;
        }
      }
    }
    await atomic([
      db
        .update(dreamQuestions)
        .set({
          answeredAt: clock.now().toISOString(),
          answeredBy: principal.userId,
          answeredNoteId: input.noteId,
          status: "answered",
        })
        .where(
          and(eq(dreamQuestions.id, row.id), eq(dreamQuestions.status, "open"))
        ),
    ]);
    return await reread(row);
  };

  /** Starts one due dream: claims its slot first, so an overlapping tick skips it. */
  const fireOne = async (
    row: {
      agentId: string;
      cron: string | null;
      id: string;
      nextRunAt: string | null;
      timezone: string;
    },
    result: DreamFireResult
  ): Promise<void> => {
    const now = clock.now();
    const schedule = row.cron === DREAM_CRONS.weekly ? "weekly" : "nightly";
    const claimed = await db
      .update(triggers)
      .set({
        lastFiredAt: now.toISOString(),
        nextRunAt: nextDreamSlot(schedule, row.timezone, now),
        timezone: row.timezone,
      })
      .where(
        and(
          eq(triggers.id, row.id),
          row.nextRunAt === null
            ? isNull(triggers.nextRunAt)
            : eq(triggers.nextRunAt, row.nextRunAt)
        )
      )
      .returning({ id: triggers.id });
    if (claimed.length === 0) {
      return;
    }
    try {
      result.fired.push((await runner.run(row.agentId)).id);
    } catch (error) {
      result.failed.push({
        agentId: row.agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /**
   * The minute tick's dream job. Each dream trigger whose 02:00 slot has come,
   * oldest first, starts a dream of its agent, a few at a time. The slot moves
   * to the next 02:00 in the workspace's timezone as the dream starts.
   */
  const fireDue = async (principal: Principal): Promise<DreamFireResult> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(DREAM_FIRE);
    }
    const due = await db
      .select({
        agentId: triggers.agentId,
        cron: triggers.cron,
        id: triggers.id,
        nextRunAt: triggers.nextRunAt,
        timezone: workspaces.timezone,
      })
      .from(triggers)
      .innerJoin(agents, eq(agents.id, triggers.agentId))
      .innerJoin(workspaces, eq(workspaces.id, triggers.workspaceId))
      .where(
        and(
          eq(triggers.kind, "dream"),
          isNull(triggers.revokedAt),
          isNull(triggers.disabledAt),
          isNotNull(triggers.nextRunAt),
          lte(triggers.nextRunAt, clock.now().toISOString()),
          eq(agents.status, "active"),
          // A paused agent does not dream. Its slot stays due, so it dreams as soon as it resumes.
          isNull(agents.pausedAt)
        )
      )
      .orderBy(asc(triggers.nextRunAt))
      .limit(DREAMS_PER_TICK);
    const result: DreamFireResult = { failed: [], fired: [] };
    await Promise.all(due.map((row) => fireOne(row, result)));
    return result;
  };

  /**
   * Whether a team's dream is due: some member's dream finished (done, skipped
   * or failed) after the team's last dream began, and no member's dream is
   * still to come tonight (its 02:00 slot is due but not fired) or running.
   * Members that are paused, or whose schedule is off or weekly and not due,
   * do not hold the team back.
   */
  const teamDue = async (teamId: string, now: string): Promise<boolean> => {
    const members = (
      await db
        .select({ id: agents.id })
        .from(teamMembers)
        .innerJoin(agents, eq(agents.id, teamMembers.memberId))
        .where(
          and(
            eq(teamMembers.teamId, teamId),
            eq(teamMembers.memberKind, "agent"),
            eq(agents.status, "active")
          )
        )
    ).map((row) => row.id);
    if (members.length === 0) {
      return false;
    }
    const [running] = await db
      .select({ id: dreamRuns.id })
      .from(dreamRuns)
      .where(
        and(
          inArray(dreamRuns.agentId, members),
          eq(dreamRuns.status, "running")
        )
      )
      .limit(1);
    const [waiting] = await db
      .select({ id: triggers.id })
      .from(triggers)
      .innerJoin(agents, eq(agents.id, triggers.agentId))
      .where(
        and(
          inArray(triggers.agentId, members),
          eq(triggers.kind, "dream"),
          isNull(triggers.revokedAt),
          isNull(triggers.disabledAt),
          isNotNull(triggers.nextRunAt),
          lte(triggers.nextRunAt, now),
          isNull(agents.pausedAt)
        )
      )
      .limit(1);
    if (running || waiting) {
      return false;
    }
    const [member] = await db
      .select({ at: max(dreamRuns.startedAt) })
      .from(dreamRuns)
      .where(
        and(
          inArray(dreamRuns.agentId, members),
          ne(dreamRuns.status, "running")
        )
      );
    const [own] = await db
      .select({ at: max(dreamRuns.startedAt) })
      .from(dreamRuns)
      .where(
        and(eq(dreamRuns.teamId, teamId), ne(dreamRuns.status, "running"))
      );
    const memberAt = member?.at ?? null;
    const ownAt = own?.at ?? null;
    return memberAt !== null && (ownAt === null || memberAt > ownAt);
  };

  /** Starts one due team's dream and files what came of it. */
  const startTeam = async (
    teamId: string,
    result: TeamDreamFireResult
  ): Promise<void> => {
    try {
      result.fired.push((await teamRunner.run(teamId)).id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A refusal to start is the state of things, not a failure, and must not use up the tick's turns.
      const refused = isServiceError(error) && error.code === "conflict";
      (refused ? result.skipped : result.failed).push({ message, teamId });
    }
  };

  /**
   * The minute tick's team dream job. A team dreams after its members' dreams
   * of the night have finished or skipped, a few teams at a time.
   */
  const fireDueTeams = async (
    principal: Principal
  ): Promise<TeamDreamFireResult> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(DREAM_FIRE);
    }
    const now = clock.now().toISOString();
    const candidates = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(isNull(teams.archivedAt), isNotNull(teams.folderPath)))
      .orderBy(asc(teams.id));
    const result: TeamDreamFireResult = { failed: [], fired: [], skipped: [] };
    for (const { id } of candidates) {
      if (result.fired.length + result.failed.length >= TEAM_DREAMS_PER_TICK) {
        break;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one team at a time keeps a failure to that team
      if (!(await teamDue(id, now))) {
        continue;
      }
      await startTeam(id, result);
    }
    return result;
  };

  /** The minute tick's repair job: every active agent whose schedule is not off has its dream trigger. */
  const syncTriggers = async (principal: Principal): Promise<number> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(DREAM_FIRE);
    }
    return await syncDreamTriggers(db, clock.now());
  };

  return {
    answer,
    changes,
    decide,
    fireDue,
    fireDueTeams,
    get,
    list,
    runNow,
    runTeamNow,
    syncTriggers,
    undo,
  };
};

export type DreamService = ReturnType<typeof createDreamService>;
