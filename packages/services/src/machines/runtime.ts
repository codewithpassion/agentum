import { runs } from "@repo/db/schema/runs";
import { and, eq } from "drizzle-orm";
import { findAgent } from "../agents.ts";
import type { RuntimeAdapter } from "../runs/types.ts";
import type { MachineRelayPort } from "./types.ts";

/**
 * Runs on the machine its agent is assigned to. Dispatch marks a queued run
 * `offered` in D1, then tells the relay to offer it: the daemon claims it over
 * HTTP. A relay that cannot be reached loses nothing, because the minute sweep
 * offers every run that stays `queued` or `offered` for over 60 seconds, so the
 * error is logged and the run is left to the sweep.
 */
export const createMachineRuntime = ({
  relay,
}: {
  relay: MachineRelayPort;
}): RuntimeAdapter => ({
  cancel: async (db, run) => {
    const agent = await findAgent(db, {
      id: run.agentId,
      workspaceId: run.workspaceId,
    });
    if (agent?.machineId) {
      await relay.cancel(agent.machineId, run.id);
    }
  },
  dispatch: async (db, run, agent) => {
    if (!agent.machineId) {
      return;
    }
    await db
      .update(runs)
      .set({ status: "offered" })
      .where(and(eq(runs.id, run.id), eq(runs.status, "queued")));
    try {
      await relay.offer(agent.machineId, {
        agentId: agent.id,
        runId: run.id,
      });
    } catch (error) {
      console.error(
        `Offering run ${run.id} failed, the sweep will retry:`,
        error
      );
    }
  },
  kind: "machine",
});
