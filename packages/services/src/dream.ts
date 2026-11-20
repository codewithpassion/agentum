import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import {
  DREAM_DECISIONS,
  type DreamQuestion,
  type DreamRun,
  type MemoryChange,
} from "@repo/db/shared";
import { z } from "zod";
import { authorize } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { readableWorkspace } from "./guards.ts";
import type { Clock } from "./runs/types.ts";
import { idString } from "./shared.ts";
import type { Principal } from "./workspaces.ts";

const DREAM_READ = "dream.read";
const DREAM_WRITE = "dream.write";
const DREAM_KIND = "dream";

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
}

const dreamResource = (workspaceId: string, id?: string) => ({
  id,
  kind: DREAM_KIND,
  workspaceId,
});

const noDreamRun = (dreamRunId: string) =>
  Promise.reject(new ServiceError("not_found", `No dream run "${dreamRunId}"`));

const noQuestion = (questionId: string) =>
  Promise.reject(new ServiceError("not_found", `No question "${questionId}"`));

/**
 * Stub: no dream run is listed, and a read or a change finds no dream run.
 * The dream service task (DR.4) fills these in. It takes the dependencies it
 * will need, so wiring it in `compose.ts` is already final.
 */
export const createDreamService = (_deps: DreamDeps) => {
  const list = (principal: Principal, agentId: string): Promise<DreamRun[]> => {
    const workspaceId = readableWorkspace(principal, DREAM_READ);
    authorize(principal, DREAM_READ, dreamResource(workspaceId, agentId));
    return Promise.resolve([]);
  };

  const get = (principal: Principal, dreamRunId: string): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_READ);
    authorize(principal, DREAM_READ, dreamResource(workspaceId, dreamRunId));
    return noDreamRun(dreamRunId);
  };

  const runNow = (principal: Principal, agentId: string): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(principal, DREAM_WRITE, dreamResource(workspaceId, agentId));
    return Promise.reject(new ServiceError("not_found", "No dream ran"));
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

  const undo = (
    principal: Principal,
    dreamRunId: string
  ): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(principal, DREAM_WRITE, dreamResource(workspaceId, dreamRunId));
    return noDreamRun(dreamRunId);
  };

  /** The `memory_changes` rows one dream wrote, held or applied. */
  const changes = (
    principal: Principal,
    dreamRunId: string
  ): Promise<MemoryChange[]> => {
    const workspaceId = readableWorkspace(principal, DREAM_READ);
    authorize(principal, DREAM_READ, dreamResource(workspaceId, dreamRunId));
    return noDreamRun(dreamRunId);
  };

  /** Approves or rejects every change a dream held, together. `memory.decide` refuses merge rows already; DR.4 makes it refuse any row with a `dreamRunId` too, so a dream's changes are never decided one by one. */
  const decide = (
    principal: Principal,
    input: DreamDecideInput
  ): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(
      principal,
      DREAM_WRITE,
      dreamResource(workspaceId, input.dreamRunId)
    );
    return noDreamRun(input.dreamRunId);
  };

  /** Keeps the chosen note, drops the others, and closes the question. */
  const answer = (
    principal: Principal,
    input: DreamAnswerInput
  ): Promise<DreamQuestion> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(
      principal,
      DREAM_WRITE,
      dreamResource(workspaceId, input.questionId)
    );
    return noQuestion(input.questionId);
  };

  return { answer, changes, decide, get, list, runNow, runTeamNow, undo };
};

export type DreamService = ReturnType<typeof createDreamService>;
