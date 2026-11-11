import type { MachineRelayPort } from "@repo/services/machines/types";
import type { MachineRelay } from "./relay.ts";

/** The services' view of the relay: one Durable Object per machine, by name. */
export const durableRelayPort = (
  namespace: DurableObjectNamespace<MachineRelay>
): MachineRelayPort => {
  const relayOf = (machineId: string) =>
    namespace.get(namespace.idFromName(machineId));
  return {
    announce: (machineId, paths) => relayOf(machineId).announce(paths),
    cancel: (machineId, runId) => relayOf(machineId).cancelRun(runId),
    clipboardGet: (machineId, principal) =>
      relayOf(machineId).clipboardGet(principal),
    clipboardSet: (machineId, principal, input) =>
      relayOf(machineId).clipboardSet(principal, input),
    computerExec: (machineId, principal, input) =>
      relayOf(machineId).computerExec(principal, input),
    computerStatus: (machineId) => relayOf(machineId).computerStatus(),
    desktopApp: (machineId, principal, input) =>
      relayOf(machineId).desktopApp(principal, input),
    desktopInput: (machineId, principal, input) =>
      relayOf(machineId).desktopInput(principal, input),
    desktopScreenshot: (machineId, principal, input) =>
      relayOf(machineId).desktopScreenshot(principal, input),
    fileGet: (machineId, principal, input) =>
      relayOf(machineId).fileGet(principal, input),
    filePut: (machineId, principal, input) =>
      relayOf(machineId).filePut(principal, input),
    offer: (machineId, run) => relayOf(machineId).offer(run),
    releaseHumanLease: (machineId, userId) =>
      relayOf(machineId).releaseHumanLease(userId),
    revoke: (machineId) => relayOf(machineId).revoke(),
    takeHumanLease: (machineId, userId) =>
      relayOf(machineId).takeHumanLease(userId),
  };
};
