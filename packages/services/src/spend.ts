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
import { and, asc, eq, gte, isNull, lt, lte } from "drizzle-orm";
import { z } from "zod";
import { authorize } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import {
  readableWorkspace,
  requireAdminSession,
  requireAgentOwnerOrAdmin,
  requireSession,
} from "./guards.ts";
import type { Clock } from "./runs/types.ts";
import {
  dayInTimezone,
  mondayWeekStart,
  paddedWindow,
  rollupSpend,
} from "./spend-rollups.ts";
import { costOf } from "./usage-cost.ts";
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
        ...runRows.map((row) => ({
          ...row,
          costUsd: costOf(row.usage),
          tasks: 1,
        })),
        ...dreams.map((row) => ({
          ...row,
          costUsd: costOf(row.usage),
          tasks: 0,
        })),
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

  /** Whether the agent's week has reached its own cap, and the workspace's week its cap. */
  const capStatus = async (agentId: string) => {
    const context = await agentContext(agentId);
    const agentCap = context.agent.weeklyCapCents;
    const workspaceCap = context.workspace.weeklyCapCents;
    if (agentCap === null && workspaceCap === null) {
      return { agentOver: false, context, workspaceOver: false };
    }
    const rows = await weekRows(
      context.workspace,
      workspaceCap === null ? agentId : undefined
    );
    return {
      agentOver:
        agentCap !== null &&
        totalCents(rows.filter((row) => row.agentId === agentId)) >= agentCap,
      context,
      workspaceOver: workspaceCap !== null && totalCents(rows) >= workspaceCap,
    };
  };

  const wouldExceed = async (agentId: string): Promise<boolean> => {
    const { agentOver, workspaceOver } = await capStatus(agentId);
    return agentOver || workspaceOver;
  };

  /**
   * Called when a run finishes. An agent over its own cap is paused, and a
   * workspace over its cap pauses every agent in it. A run in flight is never
   * touched: a pause only stops what starts next. An agent that is already
   * paused keeps its first pause.
   */
  const enforceCap = async (agentId: string): Promise<void> => {
    const { agentOver, context, workspaceOver } = await capStatus(agentId);
    if (!(agentOver || workspaceOver)) {
      return;
    }
    await db
      .update(agents)
      .set({
        pausedAt: clock.now().toISOString(),
        pausedReason: "spend_cap",
      })
      .where(
        and(
          eq(agents.workspaceId, context.workspace.id),
          eq(agents.status, "active"),
          isNull(agents.pausedAt),
          workspaceOver ? undefined : eq(agents.id, agentId)
        )
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

  /** The agent in the caller's workspace, or not found. */
  const ownAgent = async (workspaceId: string, agentId: string) => {
    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)));
    if (!agent) {
      throw new ServiceError("not_found", `No agent "${agentId}"`);
    }
    return agent;
  };

  /**
   * Who may raise or remove a limit: a person on a browser session, never an
   * agent, a key or an app, so an agent cannot lift its own cap. An agent's
   * cap is its owner's or an org admin's to change, the workspace cap an org
   * admin's.
   */
  const requireCapWriter = async (
    principal: Principal,
    agentId: string | null
  ) => {
    const workspaceId = readableWorkspace(principal, SPEND_WRITE);
    authorize(
      principal,
      SPEND_WRITE,
      spendResource(workspaceId, agentId ?? undefined)
    );
    if (agentId === null) {
      requireAdminSession(principal, SPEND_WRITE);
      return { agent: null, workspaceId };
    }
    const user = requireSession(principal, SPEND_WRITE);
    const agent = await ownAgent(workspaceId, agentId);
    requireAgentOwnerOrAdmin(user, agent, SPEND_WRITE);
    return { agent, workspaceId };
  };

  const setCap = async (
    principal: Principal,
    rawInput: SetCapInput
  ): Promise<SpendCap> => {
    const input = setCapInputSchema.parse(rawInput);
    const { agent, workspaceId } = await requireCapWriter(
      principal,
      input.agentId
    );
    await (agent
      ? db
          .update(agents)
          .set({ weeklyCapCents: input.weeklyCapCents })
          .where(eq(agents.id, agent.id))
      : db
          .update(workspaces)
          .set({ weeklyCapCents: input.weeklyCapCents })
          .where(eq(workspaces.id, workspaceId)));
    return { agentId: input.agentId, weeklyCapCents: input.weeklyCapCents };
  };

  /** Clears the pause, and sets, removes or keeps the agent's cap (`undefined` keeps it). */
  const resume = async (
    principal: Principal,
    rawInput: ResumeInput
  ): Promise<SpendResume> => {
    const input = resumeInputSchema.parse(rawInput);
    const { agent } = await requireCapWriter(principal, input.agentId);
    const weeklyCapCents =
      input.weeklyCapCents === undefined
        ? (agent?.weeklyCapCents ?? null)
        : input.weeklyCapCents;
    await db
      .update(agents)
      .set({ pausedAt: null, pausedReason: null, weeklyCapCents })
      .where(eq(agents.id, input.agentId));
    return { pausedAt: null, pausedReason: null, weeklyCapCents };
  };

  const caps = async (principal: Principal): Promise<SpendCaps> => {
    const workspaceId = readableWorkspace(principal, SPEND_READ);
    authorize(principal, SPEND_READ, spendResource(workspaceId));
    const [workspaceRow] = await db
      .select({ weeklyCapCents: workspaces.weeklyCapCents })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    const rows = await db
      .select({
        agentId: agents.id,
        pausedAt: agents.pausedAt,
        pausedReason: agents.pausedReason,
        weeklyCapCents: agents.weeklyCapCents,
      })
      .from(agents)
      .where(
        and(eq(agents.workspaceId, workspaceId), eq(agents.status, "active"))
      )
      .orderBy(asc(agents.name), asc(agents.id));
    return {
      agents: rows,
      workspaceCapCents: workspaceRow?.weeklyCapCents ?? null,
    };
  };

  return {
    byAgent,
    caps,
    enforceCap,
    resume,
    setCap,
    weekToDate,
    workspace,
    wouldExceed,
  };
};

export type SpendService = ReturnType<typeof createSpendService>;
