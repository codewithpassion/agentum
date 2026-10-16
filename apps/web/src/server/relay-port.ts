import type { MachineRelayPort } from "@repo/services/machines/types";
import type { MachineRelay } from "./relay.ts";

/** The services' view of the relay: one Durable Object per machine, by name. */
export const durableRelayPort = (
  namespace: DurableObjectNamespace<MachineRelay>
): MachineRelayPort => {
  const relayOf = (machineId: string) =>
    namespace.get(namespace.idFromName(machineId));
  return {
    cancel: (machineId, runId) => relayOf(machineId).cancelRun(runId),
    offer: (machineId, run) => relayOf(machineId).offer(run),
    revoke: (machineId) => relayOf(machineId).revoke(),
  };
};
