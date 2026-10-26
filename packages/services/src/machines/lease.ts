import { ServiceError } from "../errors.ts";
import type { MachineRelayPort } from "./types.ts";

/**
 * The desktop lease a takeover request needs, backed by the machine's relay.
 * `take` gives the desktop to the person, and refuses with a conflict when the
 * computer has no desktop or is still clearing another person's clipboard.
 * `release` lets go of whichever person holds it, because a takeover closes by
 * hand-back, cancel, expiry or the run ending, and the person who hands back
 * need not be the one who took control. Releasing a desktop nobody holds does
 * nothing, so a close that is reported twice is harmless.
 */
export const createTakeoverLease = (relay: MachineRelayPort) => ({
  release: async (machineId: string): Promise<void> => {
    const { control } = await relay.computerStatus(machineId);
    if (control !== null && control.holder.kind === "human") {
      await relay.releaseHumanLease(machineId, control.holder.userId);
    }
  },
  take: async (machineId: string, userId: string): Promise<void> => {
    const taken = await relay.takeHumanLease(machineId, userId);
    if (!taken.ok) {
      throw new ServiceError("conflict", taken.message);
    }
  },
});
