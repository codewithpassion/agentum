// The library sync of a machine run. `@repo/library-sync` does the work; this
// file builds its ports from the work directory and from the Worker's library
// routes. The agent's library folders are copied to `library/` in the work
// directory, with the manifest beside that folder, so both stay across runs
// like the rest of the agent's home. Neither call throws: a failed sync is
// logged and the run goes on. While the run lasts, a watcher on `library/`
// reports each edit, and the edits are sent out after a short quiet time.
// Neither the watcher nor the sync out throws into the run.

import type { EventEmitter } from "node:events";
import {
  type FSWatcher,
  lstatSync,
  mkdirSync,
  readdirSync,
  watch,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  type CoalescerClock,
  createCoalescer,
  createLibrarySync,
  isConflictPath,
  type LocalPort,
  type ManifestEntry,
  type ManifestStore,
  type SyncRoot,
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

/**
 * Starts watching a folder and reports each changed library path, relative to
 * the folder and with `/` separators. Conflict copies are left out. Calling the
 * returned function starts the watch and returns the stop function. It throws
 * when the folder cannot be watched.
 */
export type LibraryWatcher = (
  onPath: (libraryPath: string) => void
) => () => void;

const isFolder = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * A watcher on the library folder `dir` (made when it is missing), built on
 * `fs.watch`. It watches each folder on its own and adds a watch for each
 * folder that appears, because Bun's recursive watch on Linux reports nothing
 * for a folder made after it started, such as the run's task folder. What a
 * new folder already holds is reported when its watch starts. Links are not
 * followed. Watch errors go to `onError`.
 */
export const fsLibraryWatcher =
  (
    dir: string,
    onError: (error: unknown) => void = () => undefined
  ): LibraryWatcher =>
  (onPath) => {
    // A library with nothing in it yet leaves no folder to watch.
    mkdirSync(dir, { recursive: true });
    const watchers = new Map<string, FSWatcher>();
    let stopped = false;

    const report = (path: string) => {
      const libraryPath = relative(dir, path).split(sep).join("/");
      if (!isConflictPath(libraryPath)) {
        onPath(libraryPath);
      }
    };

    const unwatch = (folder: string) => {
      for (const [path, watcher] of watchers) {
        if (path === folder || path.startsWith(`${folder}${sep}`)) {
          watcher.close();
          watchers.delete(path);
        }
      }
    };

    // `announce` is false for the folders that were there when the watch began.
    const watchFolder = (folder: string, announce: boolean): void => {
      if (stopped || watchers.has(folder)) {
        return;
      }
      const watcher = watch(folder, (_event, name) => {
        if (name === null || stopped) {
          return;
        }
        const child = join(folder, name);
        try {
          // A folder that was deleted and made again under the same name is a
          // new folder, so its old watch goes before the new one starts. Bun
          // (1.3.11, Linux) then reports nothing more from it, and its later
          // edits wait for the next checkpoint.
          unwatch(child);
          if (isFolder(child)) {
            watchFolder(child, true);
          }
          report(child);
        } catch (error) {
          onError(error);
        }
      });
      // Bun's type of the watcher leaves out the EventEmitter it is at runtime.
      // An unhandled `error` event would end the daemon.
      (watcher as unknown as EventEmitter).on("error", onError);
      watchers.set(folder, watcher);
      try {
        for (const entry of readdirSync(folder, { withFileTypes: true })) {
          const child = join(folder, entry.name);
          if (entry.isDirectory()) {
            watchFolder(child, announce);
          }
          if (announce) {
            report(child);
          }
        }
      } catch (error) {
        unwatch(folder);
        throw error;
      }
    };

    try {
      watchFolder(dir, false);
    } catch (error) {
      stopped = true;
      unwatch(dir);
      throw error;
    }
    return () => {
      stopped = true;
      unwatch(dir);
    };
  };

export interface DaemonLibrarySyncOptions {
  /** The library routes with the run token. */
  api: LibraryApi;
  /** The clock the watch batches edits with. Defaults to the system timers. */
  clock?: CoalescerClock<number>;
  disk: WorkDisk;
  /** Where progress and failures go, one line each. */
  log: (message: string) => void;
  /** The longest an edit waits before it is sent, however often it changes. */
  maxMs?: number;
  /** Quiet time after the last edit before the edits are sent. */
  quietMs?: number;
  /** The library roots to sync: the agent's folder and the paths its config names, each read or write. */
  roots: readonly SyncRoot[];
  /** Names the conflict copies a sync out makes. */
  runId: string;
  /** Watches `library/` for edits. Without it, `startWatching` does nothing. */
  watcher?: LibraryWatcher;
}

export interface DaemonLibrarySync {
  /** The given library paths that equal a root or sit under one, in any mode. */
  covered: (paths: readonly string[]) => string[];
  /** Syncs the given library paths in, the ones under a root. Resolves when done. Never rejects. */
  pull: (paths: readonly string[]) => Promise<void>;
  /** Starts watching the library. Returns true when watching, false when there is no watcher or it failed. Calling it again while watching does nothing. */
  startWatching: () => boolean;
  /** Stops the watch and drops the edits not sent yet. */
  stopWatching: () => void;
  /** Copies the library into the work directory, or only the `only` paths within the roots. Resolves true when the copy is in place, false when the sync failed. Never rejects. */
  syncIn: (only?: readonly string[]) => Promise<boolean>;
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
  const { api, log, roots, runId, watcher } = options;
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

  const covered = (paths: readonly string[]): string[] =>
    paths.filter((path) =>
      roots.some(
        (root) => path === root.path || path.startsWith(`${root.path}/`)
      )
    );

  const syncIn = (only?: readonly string[]) =>
    inTurn(async () => {
      try {
        const result = await sync.syncIn({
          roots,
          ...(only === undefined ? {} : { only }),
        });
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

  const refusedBefore = new Set<string>();

  const syncOut = () =>
    inTurn(async () => {
      try {
        const result = await sync.syncOut({ roots, runId });
        log(
          `library synced out: ${result.written.length} written, ${result.deleted.length} deleted, ${result.conflicts.length} conflict(s), ${result.skipped.length} skipped for size`
        );
        // A read-only edit stays refused at every sync, so each path is named once.
        const newlyRefused = result.refused.filter(
          (path) => !refusedBefore.has(path)
        );
        for (const path of newlyRefused) {
          refusedBefore.add(path);
        }
        if (newlyRefused.length > 0) {
          log(
            `warning: ${newlyRefused.length} change(s) under read-only library paths were not sent: ${newlyRefused.join(", ")}`
          );
        }
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

  const batcher = createCoalescer({
    clock: options.clock,
    maxMs: options.maxMs,
    onBatch: () => syncOut(),
    quietMs: options.quietMs,
  });

  // The token ties each watch to its callback, so a report that arrives after
  // a stop, or from an earlier watch, is dropped.
  let watching: { stop: () => void; token: object } | undefined;

  const startWatching = (): boolean => {
    if (watching !== undefined) {
      return true;
    }
    if (watcher === undefined) {
      return false;
    }
    const token = {};
    try {
      const stop = watcher((libraryPath) => {
        if (watching?.token === token) {
          batcher.add(libraryPath);
        }
      });
      watching = { stop, token };
      return true;
    } catch (error) {
      log(
        `warning: watching the library failed, changes go back at the next checkpoint: ${messageOf(error)}`
      );
      return false;
    }
  };

  const stopWatching = (): void => {
    const current = watching;
    watching = undefined;
    batcher.cancel();
    current?.stop();
  };

  const pull = async (paths: readonly string[]): Promise<void> => {
    const only = covered(paths);
    if (only.length === 0) {
      return;
    }
    await syncIn(only);
  };

  return {
    covered,
    pull,
    startWatching,
    stopWatching,
    syncIn,
    syncOut,
  };
};
