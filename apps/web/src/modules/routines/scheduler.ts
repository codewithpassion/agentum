import { DurableObject } from "cloudflare:workers";
import { createDb, type Db } from "#/db/client";
import { getWorkspaceById } from "#/modules/workspaces/service";
import {
  advanceRoutine,
  earliestNextRunAt,
  fireRoutine,
  listDueRoutines,
} from "./service";

/**
 * One scheduler per workspace (`idFromName(workspaceId)`), holding exactly one
 * alarm: the earliest `next_run_at` across that workspace's enabled routines.
 * The routines service re-arms it after every create, update, delete and
 * toggle; the alarm re-arms itself after every firing. No cron triggers (they
 * cannot be per-row) and no polling.
 *
 * Like `AgentRouter`, the instance cannot read back the name it was addressed
 * with, so the workspace arrives with the traffic - `reschedule(workspaceId)`
 * writes it to storage before anything else, which is what guarantees every
 * alarm it ever schedules finds a tenant waiting for it.
 *
 * Missed fires collapse (docs/plan-routines.md, decision 6): a routine whose
 * slot passed while the scheduler was asleep fires once, and its next slot is
 * computed from *now* rather than from the slot it missed.
 */

/** The workspace this instance schedules for, learned on first contact. */
export const WORKSPACE_KEY = "workspaceId";

export const schedulerStub = (env: Env, workspaceId: string) =>
  env.ROUTINE_SCHEDULER.get(env.ROUTINE_SCHEDULER.idFromName(workspaceId));

/**
 * Re-arm a workspace's scheduler. Best effort by design: a scheduler that
 * cannot be reached must not fail the mutation that called it, and the routine
 * row - which is the source of truth - is already written.
 */
export const rescheduleRoutines = async (
  env: Env,
  workspaceId: string
): Promise<void> => {
  try {
    await schedulerStub(env, workspaceId).reschedule(workspaceId);
  } catch {
    // The next firing, or the next mutation, arms it again.
  }
};

export class RoutineScheduler extends DurableObject<Env> {
  private database: Db | null = null;
  /** Memoised `WORKSPACE_KEY`; storage stays the source of truth. */
  private scope: string | null = null;

  private get db(): Db {
    this.database ??= createDb(this.env.DB);
    return this.database;
  }

  private async workspaceId(): Promise<string | null> {
    this.scope ??= (await this.ctx.storage.get<string>(WORKSPACE_KEY)) ?? null;
    return this.scope;
  }

  /** Called after every routine mutation. Recomputes the one alarm. */
  async reschedule(workspaceId: string): Promise<void> {
    if (this.scope !== workspaceId) {
      this.scope = workspaceId;
      await this.ctx.storage.put(WORKSPACE_KEY, workspaceId);
    }
    await this.arm();
  }

  override async alarm(): Promise<void> {
    const workspaceId = await this.workspaceId();
    if (!workspaceId) {
      // An alarm with no tenant can only be a stale one; it has nothing to
      // scan and nothing to schedule.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }

    const workspace = await getWorkspaceById(this.db, workspaceId);
    if (!workspace) {
      // The workspace was deleted. Its routines went with it, so this instance
      // has no reason to exist either.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }

    const now = new Date();
    const due = await listDueRoutines(this.db, workspaceId, now);
    for (const routine of due) {
      // In turn: each firing publishes a message, and the order routines were
      // due in is the order their messages should appear in.
      // biome-ignore lint/performance/noAwaitInLoops: routines fire in the order they came due
      await fireRoutine(
        this.db,
        this.env,
        { id: workspace.id, slug: workspace.slug },
        routine,
        routine.nextRunAt ?? now
      ).catch(() => {
        // `fireRoutine` records its own failures on the run row; a throw past
        // it must not cost the routines behind this one their turn.
      });
      // From `now`, not from the slot that just fired: that is what collapses a
      // backlog into a single catch-up run.
      await advanceRoutine(this.db, routine, new Date()).catch(() => {
        // Leaving `next_run_at` where it is means this routine is tried again
        // on the next alarm rather than being lost.
      });
    }

    await this.arm();
  }

  /** The one alarm: the earliest pending firing, or none at all. */
  private async arm(): Promise<void> {
    const workspaceId = await this.workspaceId();
    if (!workspaceId) {
      return;
    }
    const next = await earliestNextRunAt(this.db, workspaceId);
    if (next === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    // A slot already in the past (a routine created while the scheduler was
    // asleep) fires on the next tick rather than waiting for its successor.
    await this.ctx.storage.setAlarm(Math.max(next.getTime(), Date.now()));
  }
}
