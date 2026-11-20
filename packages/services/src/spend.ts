import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { dreamRuns } from "@repo/db/schema/dreams";
import { runs } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import type {
  SpendCap,
  SpendCaps,
  SpendResume,
  SpendRow,
} from "@repo/db/shared";
import { and, eq, gte, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { authorize } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { readableWorkspace } from "./guards.ts";
import type { Clock } from "./runs/types.ts";
import {
  dayInTimezone,
  mondayWeekStart,
  paddedWindow,
  rollupSpend,
} from "./spend-rollups.ts";
import type { Principal } from "./workspaces.ts";

const SPEND_READ = "spend.read";
const SPEND_WRITE = "spend.write";
const SPEND_KIND = "spend";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (day: string): boolean => {
  if (!DAY.test(day)) {
    return false;
  }
  const parsed = new Date(`${day}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(day)
  );
};
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

/** Workspace reads and internal cap accounting share the same daily rollups. */
export const createSpendService = ({ db, clock }: SpendDeps) => {
  const read = async (
    workspaceId: string,
    range: SpendRangeInput,
    agentId?: string,
    through?: Date
  ): Promise<SpendRow[]> => {
    const [workspaceRow] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!workspaceRow) {
      return [];
    }
    const { start, end } = paddedWindow(range.from, range.to);
    const [runRows, dreams] = await Promise.all([
      db
        .select({
          agentId: runs.agentId,
          at: runs.createdAt,
          usage: runs.usage,
        })
        .from(runs)
        .innerJoin(agents, eq(agents.id, runs.agentId))
        .where(
          and(
            eq(runs.workspaceId, workspaceId),
            eq(agents.workspaceId, workspaceId),
            eq(runs.dryRun, false),
            gte(runs.createdAt, start),
            lt(runs.createdAt, end),
            agentId === undefined ? undefined : eq(runs.agentId, agentId),
            through ? lte(runs.createdAt, through.toISOString()) : undefined
          )
        ),
      db
        .select({
          agentId: dreamRuns.agentId,
          at: dreamRuns.startedAt,
          usage: dreamRuns.usage,
        })
        .from(dreamRuns)
        .innerJoin(agents, eq(agents.id, dreamRuns.agentId))
        .where(
          and(
            eq(dreamRuns.workspaceId, workspaceId),
            eq(agents.workspaceId, workspaceId),
            gte(dreamRuns.startedAt, start),
            lt(dreamRuns.startedAt, end),
            agentId === undefined ? undefined : eq(dreamRuns.agentId, agentId),
            through
              ? lte(dreamRuns.startedAt, through.toISOString())
              : undefined
          )
        ),
    ]);
    return rollupSpend(
      [
        ...runRows.map((row) => ({ ...row, tasks: 1 })),
        ...dreams.map((row) => ({ ...row, tasks: 0 })),
      ],
      workspaceRow.timezone,
      range
    );
  };

  const agentContext = async (agentId: string) => {
    const [context] = await db
      .select({ agent: agents, workspace: workspaces })
      .from(agents)
      .innerJoin(workspaces, eq(workspaces.id, agents.workspaceId))
      .where(eq(agents.id, agentId));
    if (!context) {
      throw new ServiceError("not_found", `No agent "${agentId}"`);
    }
    return context;
  };

  const weekRows = (
    workspaceRow: typeof workspaces.$inferSelect,
    agentId?: string
  ) => {
    const now = clock.now();
    return read(
      workspaceRow.id,
      {
        from: mondayWeekStart(now, workspaceRow.timezone),
        to: dayInTimezone(now, workspaceRow.timezone),
      },
      agentId,
      now
    );
  };

  // Weekly cents sum rounded agent-days so cap enforcement agrees with the spend page.
  const totalCents = (rows: SpendRow[]) =>
    rows.reduce((total, row) => total + row.cents, 0);

  const weekToDate = async (agentId: string): Promise<number> => {
    const context = await agentContext(agentId);
    return totalCents(await weekRows(context.workspace, agentId));
  };

  const wouldExceed = async (agentId: string): Promise<boolean> => {
    const context = await agentContext(agentId);
    const agentCap = context.agent.weeklyCapCents;
    const workspaceCap = context.workspace.weeklyCapCents;
    if (agentCap === null && workspaceCap === null) {
      return false;
    }
    const rows = await weekRows(
      context.workspace,
      workspaceCap === null ? agentId : undefined
    );
    return (
      (agentCap !== null &&
        totalCents(rows.filter((row) => row.agentId === agentId)) >=
          agentCap) ||
      (workspaceCap !== null && totalCents(rows) >= workspaceCap)
    );
  };

  const workspace = (
    principal: Principal,
    range: SpendRangeInput
  ): Promise<SpendRow[]> => {
    const workspaceId = readableWorkspace(principal, SPEND_READ);
    authorize(principal, SPEND_READ, spendResource(workspaceId));
    return read(workspaceId, spendRangeSchema.parse(range));
  };

  const byAgent = (
    principal: Principal,
    agentId: string,
    range: SpendRangeInput
  ): Promise<SpendRow[]> => {
    const workspaceId = readableWorkspace(principal, SPEND_READ);
    authorize(principal, SPEND_READ, spendResource(workspaceId, agentId));
    return read(workspaceId, spendRangeSchema.parse(range), agentId);
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

  return { byAgent, caps, resume, setCap, weekToDate, workspace, wouldExceed };
};

export type SpendService = ReturnType<typeof createSpendService>;
