import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { dreamQuestions, dreamRuns } from "@repo/db/schema/dreams";
import { memoryChanges } from "@repo/db/schema/memory";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  DREAM_DECISIONS,
  type DreamQuestion,
  type DreamRun,
  type MemoryChange,
} from "@repo/db/shared";
import { and, asc, desc, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { isReadOnly } from "./automation-access.ts";
import type { Fetcher } from "./connectors/mcp.ts";
import { heldCounts } from "./dream/held.ts";
import { readOptions } from "./dream/question-options.ts";
import {
  loadDreamAgent,
  type QuestionRow,
  type RunRow,
  toQuestion,
  toRun,
} from "./dream/rows.ts";
import { createDreamRunner } from "./dream/run.ts";
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
  library: DreamMemoryLibrary;
  managedKeys: Pick<ManagedKeysService, "resolve">;
  /** A person's answer to a question forgets the notes it did not keep, as that person. */
  memory: Pick<MemoryService, "forget">;
  skillsStore: Pick<SkillsStoreService, "list" | "proposeForAgent">;
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

  /** The dreams as the contract type, each with the changes it still holds. */
  const withHeld = async (rows: readonly RunRow[]): Promise<DreamRun[]> => {
    const held = await heldCounts(
      db,
      rows.map((row) => row.id)
    );
    return rows.map((row) => toRun(row, held.get(row.id) ?? 0));
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

  /** Stub: the team dream task (TX.2) fills this in. */
  const runTeamNow = (
    principal: Principal,
    teamId: string
  ): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(principal, DREAM_WRITE, dreamResource(workspaceId, teamId));
    return Promise.reject(new ServiceError("not_found", "No team dream ran"));
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
      throw new ServiceError("invalid", "A team dream is undone by the team");
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
      throw new ServiceError("invalid", "A team dream is decided by the team");
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
    if (!keep.includes(input.noteId) || row.agentId === null) {
      throw new ServiceError("invalid", "Choose one of the notes asked about");
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
    const [closed] = await db
      .select()
      .from(dreamQuestions)
      .where(eq(dreamQuestions.id, row.id))
      .limit(1);
    return toQuestion(closed ?? row);
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
    get,
    list,
    runNow,
    runTeamNow,
    syncTriggers,
    undo,
  };
};

export type DreamService = ReturnType<typeof createDreamService>;
