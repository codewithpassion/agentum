import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import type {
  SpendCap,
  SpendCaps,
  SpendResume,
  SpendRow,
} from "@repo/db/shared";
import { z } from "zod";
import { authorize } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { readableWorkspace } from "./guards.ts";
import type { Clock } from "./runs/types.ts";
import type { Principal } from "./workspaces.ts";

const SPEND_READ = "spend.read";
const SPEND_WRITE = "spend.write";
const SPEND_KIND = "spend";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (day: string): boolean =>
  DAY.test(day) && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);
const daySchema = z.string().refine(isRealDay, "Not a day, use YYYY-MM-DD");
const agentIdSchema = z.string().min(1);
const capSchema = z.number().int().positive().nullable();

const inOrder = ({ from, to }: { from: string; to: string }): boolean =>
  from <= to;
const ORDER_MESSAGE = "from is after to";

/** The days a read covers as `YYYY-MM-DD`, both ends included. */
export const spendRangeSchema = z
  .strictObject({ from: daySchema, to: daySchema })
  .refine(inOrder, ORDER_MESSAGE);

export const byAgentInputSchema = z
  .strictObject({ agentId: agentIdSchema, from: daySchema, to: daySchema })
  .refine(inOrder, ORDER_MESSAGE);

/** `agentId: null` sets the workspace cap. `weeklyCapCents: null` removes the cap. */
export const setCapInputSchema = z.strictObject({
  agentId: agentIdSchema.nullable(),
  weeklyCapCents: capSchema,
});

/** Leave `weeklyCapCents` out to keep the cap, or send a new one (null removes it). */
export const resumeInputSchema = z.strictObject({
  agentId: agentIdSchema,
  weeklyCapCents: capSchema.optional(),
});

export type SpendRangeInput = z.infer<typeof spendRangeSchema>;
export type SetCapInput = z.infer<typeof setCapInputSchema>;
export type ResumeInput = z.infer<typeof resumeInputSchema>;

export interface SpendDeps {
  atomic: Atomic;
  clock: Clock;
  db: Database;
}

const spendResource = (workspaceId: string, id?: string) => ({
  id,
  kind: SPEND_KIND,
  workspaceId,
});

/**
 * Stub: nothing is spent, no cap is set, and a cap or a resume finds nothing
 * to change. Who may set a cap or resume an agent is for the enforcement task. The
 * spend service task fills these from run usage and the cap and pause columns.
 * It takes the dependencies it will need, so wiring it in `compose.ts` is
 * already final.
 */
export const createSpendService = (_deps: SpendDeps) => {
  const workspace = (
    principal: Principal,
    _range: SpendRangeInput
  ): Promise<SpendRow[]> => {
    const workspaceId = readableWorkspace(principal, SPEND_READ);
    authorize(principal, SPEND_READ, spendResource(workspaceId));
    return Promise.resolve([]);
  };

  const byAgent = (
    principal: Principal,
    agentId: string,
    _range: SpendRangeInput
  ): Promise<SpendRow[]> => {
    const workspaceId = readableWorkspace(principal, SPEND_READ);
    authorize(principal, SPEND_READ, spendResource(workspaceId, agentId));
    return Promise.resolve([]);
  };

  const setCap = (
    principal: Principal,
    input: SetCapInput
  ): Promise<SpendCap> => {
    const workspaceId = readableWorkspace(principal, SPEND_WRITE);
    authorize(
      principal,
      SPEND_WRITE,
      spendResource(workspaceId, input.agentId ?? undefined)
    );
    return Promise.reject(
      new ServiceError(
        "not_found",
        input.agentId ? `No agent "${input.agentId}"` : "No workspace"
      )
    );
  };

  const resume = (
    principal: Principal,
    input: ResumeInput
  ): Promise<SpendResume> => {
    const workspaceId = readableWorkspace(principal, SPEND_WRITE);
    authorize(
      principal,
      SPEND_WRITE,
      spendResource(workspaceId, input.agentId)
    );
    return Promise.reject(
      new ServiceError("not_found", `No agent "${input.agentId}"`)
    );
  };

  const caps = (principal: Principal): Promise<SpendCaps> => {
    const workspaceId = readableWorkspace(principal, SPEND_READ);
    authorize(principal, SPEND_READ, spendResource(workspaceId));
    return Promise.resolve({ agents: [], workspaceCapCents: null });
  };

  return { byAgent, caps, resume, setCap, workspace };
};

export type SpendService = ReturnType<typeof createSpendService>;
