import { findAgent } from "../agents.ts";
import type { RuntimeAdapter } from "../runs/types.ts";
import type { MachineRelayPort } from "./types.ts";

/**
 * Runs on the machine its agent is assigned to. Dispatch only tells the relay
 * to offer the run: the run stays in D1 and the daemon claims it over HTTP. A
 * relay that cannot be reached loses nothing, because the minute sweep offers
 * every run that stays `queued` or `offered` for over 60 seconds, so the error
 * is logged and the run is left to the sweep.
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
  dispatch: async (_db, run, agent) => {
    if (!agent.machineId) {
      return;
    }
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
