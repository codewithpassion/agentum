// The `notify` listener of the library service: after a library write commits,
// it tells every running run whose sync scope covers a changed path to pull it.
// A machine run hears it as a `library_changed` frame through its machine's
// relay, a run in a Linux VM through an RPC on its `PiRun`. The work is handed
// to `defer` (`waitUntil`) and a failure is logged, so a write never fails or
// waits on it.
import type { LibraryChange } from "@repo/db/shared";
import type { CloudRunnerPort } from "@repo/services/cloud/types";
import type { LibraryAudience } from "@repo/services/library/audience";
import type { MachineRelayPort } from "@repo/services/machines/types";

export interface LibraryNotifierDeps {
  /** The runs that take the change. `createLibraryAudience` in the app. */
  audience: (change: LibraryChange) => Promise<LibraryAudience>;
  /** Runs work after the response: `waitUntil` in a request. Without it, work is awaited. */
  defer?: (work: Promise<void>) => void;
  relay: Pick<MachineRelayPort, "announce">;
  /** Reaches the runs in a Linux VM. Without it, they hear nothing. */
  runner?: Pick<CloudRunnerPort, "libraryChanged">;
}

const logFailure = (error: unknown) => {
  console.error("Library change announcement failed", error);
};

export const libraryNotifier = ({
  audience,
  defer,
  relay,
  runner,
}: LibraryNotifierDeps): ((change: LibraryChange) => Promise<void>) => {
  const announce = async (change: LibraryChange): Promise<void> => {
    const { cloud, machines } = await audience(change);
    // One failed target must not keep the others from hearing the change.
    await Promise.all([
      ...machines.map(({ machineId, paths }) =>
        relay.announce(machineId, paths).catch(logFailure)
      ),
      ...cloud.map(({ paths, sessionId }) =>
        runner?.libraryChanged?.(sessionId, paths).catch(logFailure)
      ),
    ]);
  };
  return async (change) => {
    const work = announce(change).catch(logFailure);
    if (defer) {
      defer(work);
      return;
    }
    await work;
  };
};
