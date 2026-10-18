// The library sync of a machine run. `@repo/library-sync` does the work; this
// file builds its ports from the work directory and from the Worker's library
// routes. The agent's library folders are copied to `library/` in the work
// directory, with the manifest beside that folder, so both stay across runs
// like the rest of the agent's home. Neither call throws: a failed sync is
// logged and the run goes on.

import {
  createLibrarySync,
  type LocalPort,
  type ManifestEntry,
  type ManifestStore,
} from "@repo/library-sync";
import type { LibraryApi } from "./library-api.ts";
import type { WorkDisk } from "./work-disk.ts";

/** The folder in the work directory that holds the library copy. */
export const LIBRARY_DIR = "library";

/** The manifest file, in the work directory beside `library/`, not inside it. */
export const LIBRARY_MANIFEST = "library.manifest.json";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The library port of the copy under `<workDir>/library`. */
export const diskLocalPort = (disk: WorkDisk): LocalPort => {
  const under = (path: string) => `${LIBRARY_DIR}/${path}`;
  return {
    list: (dir) => disk.list(under(dir)),
    read: (path) => disk.read(under(path)),
    remove: (path) => disk.remove(under(path)),
    stat: (path) => disk.stat(under(path)),
    write: (path, bytes) => disk.write(under(path), bytes),
  };
};

const isManifestEntry = (value: unknown): value is ManifestEntry =>
  typeof value === "object" &&
  value !== null &&
  "etag" in value &&
  typeof value.etag === "string" &&
  "path" in value &&
  typeof value.path === "string" &&
  "sha256" in value &&
  typeof value.sha256 === "string";

/** The manifest of the copy, kept beside it as JSON. A file that is missing or does not parse reads as empty. */
export const diskManifestStore = (disk: WorkDisk): ManifestStore => ({
  load: async () => {
    if ((await disk.stat(LIBRARY_MANIFEST)) === null) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        TEXT_DECODER.decode(await disk.read(LIBRARY_MANIFEST))
      );
    } catch {
      return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isManifestEntry) : [];
  },
  save: (entries) =>
    disk.write(LIBRARY_MANIFEST, TEXT_ENCODER.encode(JSON.stringify(entries))),
});

export interface DaemonLibrarySyncOptions {
  /** The library routes with the run token. */
  api: LibraryApi;
  disk: WorkDisk;
  /** Where progress and failures go, one line each. */
  log: (message: string) => void;
  /** The library paths to sync: the agent's folder and the paths its config names. */
  paths: readonly string[];
  /** Names the conflict copies a sync out makes. */
  runId: string;
}

export interface DaemonLibrarySync {
  /** Copies the library into the work directory. Resolves true when the copy is in place, false when the sync failed. Never rejects. */
  syncIn: () => Promise<boolean>;
  /** Sends the local changes to the library and records each conflict. Never rejects. */
  syncOut: () => Promise<void>;
}

/**
 * Syncs take turns: a checkpoint that is still running when the run ends
 * finishes first, because both read and write the same manifest.
 */
export const createDaemonLibrarySync = (
  options: DaemonLibrarySyncOptions
): DaemonLibrarySync => {
  const { api, log, paths, runId } = options;
  const sync = createLibrarySync({
    local: diskLocalPort(options.disk),
    manifest: diskManifestStore(options.disk),
    remote: api,
  });
  let queue: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  const syncIn = () =>
    inTurn(async () => {
      try {
        const result = await sync.syncIn({ roots: paths });
        log(
          `library synced in: ${result.pulled.length} pulled, ${result.removed.length} removed, ${result.kept.length} kept for local edits, ${result.skipped.length} skipped for size`
        );
        if (result.failed.length > 0) {
          log(
            `warning: ${result.failed.length} library file(s) did not sync in: ${result.failed.map((failure) => failure.path).join(", ")}`
          );
        }
        return true;
      } catch (error) {
        log(
          `warning: syncing the library in failed, the run goes ahead without a library copy: ${messageOf(error)}`
        );
        return false;
      }
    });

  const recordConflict = async (conflict: {
    conflictPath: string;
    path: string;
  }): Promise<void> => {
    try {
      await api.recordConflict(conflict);
    } catch (error) {
      log(
        `warning: recording the library conflict for ${conflict.path} failed: ${messageOf(error)}`
      );
    }
  };

  const syncOut = () =>
    inTurn(async () => {
      try {
        const result = await sync.syncOut({ roots: paths, runId });
        log(
          `library synced out: ${result.written.length} written, ${result.deleted.length} deleted, ${result.conflicts.length} conflict(s), ${result.skipped.length} skipped for size`
        );
        await Promise.all(result.conflicts.map(recordConflict));
        if (result.failed.length > 0) {
          log(
            `warning: ${result.failed.length} library file(s) did not sync out: ${result.failed.map((failure) => failure.path).join(", ")}`
          );
        }
      } catch (error) {
        log(
          `warning: syncing the library out failed, the changes wait for the next run: ${messageOf(error)}`
        );
      }
    });

  return { syncIn, syncOut };
};
