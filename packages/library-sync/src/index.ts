/**
 * Library sync: keeps a working copy of part of the workspace library in step
 * with the library, with the library's etags as versions. Used by the Linux VM
 * (W.7) and by machines (W.8). The module imports no app code: the library
 * and the working copy come in as ports (see `types.ts`).
 *
 * `syncIn` copies the library into the working copy and never overwrites a
 * local edit that was not sent yet. `syncOut` sends local changes with a
 * compare-and-swap on the etag. A change that lost the race is saved in the
 * library as `<path>.conflict-<runId>` and the library's file is kept, with no
 * merge and no last-write-wins.
 */
import { runSyncIn } from "./sync-in.ts";
import { runSyncOut } from "./sync-out.ts";
import type {
  SyncInResult,
  SyncOptions,
  SyncOutOptions,
  SyncOutResult,
  SyncPorts,
} from "./types.ts";

export type {
  LocalEntry,
  LocalPort,
  ManifestEntry,
  ManifestStore,
  RemoteEntry,
  RemotePort,
  SyncConflict,
  SyncFailure,
  SyncInResult,
  SyncOptions,
  SyncOutOptions,
  SyncOutResult,
  SyncPorts,
} from "./types.ts";

export const createLibrarySync = (ports: SyncPorts) => ({
  syncIn: (options: SyncOptions): Promise<SyncInResult> =>
    runSyncIn(ports, options),
  syncOut: (options: SyncOutOptions): Promise<SyncOutResult> =>
    runSyncOut(ports, options),
});

export type LibrarySync = ReturnType<typeof createLibrarySync>;
