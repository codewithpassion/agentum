import { guestUnavailable } from "../runs/guest-scope.ts";
import type { RuntimeAdapter } from "../runs/types.ts";
export interface GuestRunnerPort {
  cancel: (runId: string) => Promise<void>;
  start: (runId: string) => Promise<void>;
}
/** Separate from every ordinary adapter; the port names one isolated DO/run. */
export const createDurableGuestRuntime = (
  runner: GuestRunnerPort
): RuntimeAdapter => ({
  abandon: (run) => runner.cancel(run.id),
  cancel: (_db, run) => runner.cancel(run.id),
  dispatch: async (_db, run) => {
    if (
      !run.scopeArtifactId ||
      run.actor.kind !== "guest" ||
      run.inputFileIds.length ||
      run.reply.kind !== "none"
    ) {
      throw guestUnavailable();
    }
    await runner.start(run.id);
  },
  kind: "cloud",
  resume: (run) => runner.start(run.id),
});
