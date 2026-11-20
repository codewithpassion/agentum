import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import type { DreamRun } from "@repo/db/shared";
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

export const dreamRunIdInputSchema = z.strictObject({ dreamRunId: idString });

export type DreamAgentInput = z.input<typeof dreamAgentInputSchema>;
export type DreamRunIdInput = z.input<typeof dreamRunIdInputSchema>;

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

  const undo = (
    principal: Principal,
    dreamRunId: string
  ): Promise<DreamRun> => {
    const workspaceId = readableWorkspace(principal, DREAM_WRITE);
    authorize(principal, DREAM_WRITE, dreamResource(workspaceId, dreamRunId));
    return noDreamRun(dreamRunId);
  };

  return { get, list, runNow, undo };
};

export type DreamService = ReturnType<typeof createDreamService>;
