import { runs } from "@repo/db/schema/runs";
import { and, eq } from "drizzle-orm";
import type { RuntimeAdapter } from "../runs/types.ts";
import type { ManagedPollerPort } from "./types.ts";

/**
 * Runs on Anthropic Managed Agents. Dispatch only marks the run `offered` and
 * wakes its poller, which does the slow part (registering the agent, making
 * the session, reading its events) outside the request. A poller that cannot
 * be reached loses nothing: the minute sweep offers every run that stays
 * `queued` or `offered` for over 60 seconds, which wakes it again.
 */
export const createManagedRuntime = ({
  poller,
}: {
  poller: ManagedPollerPort;
}): RuntimeAdapter => ({
  cancel: async (_db, run) => {
    try {
      await poller.cancel(run.id);
    } catch (error) {
      console.error(`Stopping managed run ${run.id} failed:`, error);
    }
  },
  dispatch: async (db, run) => {
    await db
      .update(runs)
      .set({ status: "offered" })
      .where(and(eq(runs.id, run.id), eq(runs.status, "queued")));
    try {
      await poller.kick(run.id);
    } catch (error) {
      console.error(
        `Waking the poller for run ${run.id} failed, the sweep will retry:`,
        error
      );
    }
  },
  kind: "managed",
});
