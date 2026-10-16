/** What the machines service and the machine runtime adapter ask of the relay. */
export interface MachineRelayPort {
  /** Tells the daemon to stop a run. Does nothing when no socket is open. */
  cancel: (machineId: string, runId: string) => Promise<void>;
  /** Offers a run to the daemon. Does nothing when no socket is open. */
  offer: (
    machineId: string,
    offer: { agentId: string; runId: string }
  ) => Promise<void>;
  /** Closes every open socket of the machine with 4401. */
  revoke: (machineId: string) => Promise<void>;
}

/** A relay with no daemon behind it: scripts and tests that only need the port filled. */
export const noopRelay: MachineRelayPort = {
  cancel: () => Promise.resolve(),
  offer: () => Promise.resolve(),
  revoke: () => Promise.resolve(),
};
