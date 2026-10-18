/**
 * The ports and results of the library sync. The module knows no app code and
 * no VM code: the remote side (the workspace library) and the local side (a
 * working copy on some disk) come in as ports, and every path is a library
 * path with no leading slash, such as `agents/ada/notes.md`. Outcomes are
 * values, not errors the module would have to recognise: `null` means "not
 * there" or "lost the race", and the caller's adapter maps its own errors.
 */

/** The largest file the sync copies in either direction: 10 MB, the library's own cap. */
export const SYNC_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** A file or folder of the library. `etag` is null for a folder. */
export interface RemoteEntry {
  etag: string | null;
  kind: "dir" | "file";
  path: string;
  size: number;
}

export interface RemotePort {
  /** Removes a file. A path that is not there is not an error. */
  delete: (path: string) => Promise<void>;
  /** The entries directly in a folder. A folder that is not there lists as empty. */
  list: (dir: string) => Promise<RemoteEntry[]>;
  /** A file's bytes with its current etag, or null when there is no such file. */
  read: (path: string) => Promise<{ bytes: Uint8Array; etag: string } | null>;
  /** The entry at a path, or null when there is none. */
  stat: (path: string) => Promise<RemoteEntry | null>;
  /**
   * Stores the bytes and returns the new etag. With `ifEtag` the file is kept
   * only if it exists with that etag, and the answer is null when it does not.
   */
  write: (
    path: string,
    bytes: Uint8Array,
    options?: { ifEtag?: string }
  ) => Promise<{ etag: string } | null>;
}

export interface LocalEntry {
  kind: "dir" | "file";
  name: string;
}

export interface LocalPort {
  /** The entries directly in a folder. A folder that is not there lists as empty. Anything that is neither a file nor a folder (a link) is left out. */
  list: (dir: string) => Promise<LocalEntry[]>;
  read: (path: string) => Promise<Uint8Array>;
  /** Removes a file. A path that is not there is not an error. */
  remove: (path: string) => Promise<void>;
  /** The entry at a path, or null when there is none. */
  stat: (
    path: string
  ) => Promise<{ kind: "dir" | "file"; size: number } | null>;
  /** Writes the file and makes the folders above it. */
  write: (path: string, bytes: Uint8Array) => Promise<void>;
}

/** What the last sync left in step: a file's etag in the library and the hash of the local bytes. */
export interface ManifestEntry {
  etag: string;
  path: string;
  sha256: string;
}

/** Where the manifest lives, beside the working copy and not inside it. One manifest per working copy. */
export interface ManifestStore {
  /** The saved entries, or an empty list when nothing was saved yet. */
  load: () => Promise<ManifestEntry[]>;
  save: (entries: ManifestEntry[]) => Promise<void>;
}

export interface SyncPorts {
  local: LocalPort;
  manifest: ManifestStore;
  remote: RemotePort;
}

export interface SyncOptions {
  /** Files over this many bytes are skipped. Defaults to SYNC_MAX_FILE_BYTES. */
  maxFileBytes?: number;
  /** Library paths to sync: the agent's folder `agents/<slug>` and the paths its config names. A path may be a folder or a file. */
  roots: readonly string[];
}

export interface SyncOutOptions extends SyncOptions {
  /** The run that ends: a conflict copy is named for it. */
  runId: string;
}

/** A file the sync could not move. The others still went through. */
export interface SyncFailure {
  message: string;
  path: string;
}

export interface SyncInResult {
  /** Paths of conflict copies in the library under the roots, from this run or earlier ones, still waiting for the agent. */
  conflicts: string[];
  failed: SyncFailure[];
  /** Local files left alone because they hold edits not yet sent. */
  kept: string[];
  /** Files copied or replaced locally. */
  pulled: string[];
  /** Local files removed because the library deleted them. */
  removed: string[];
  /** Files over the size limit. */
  skipped: string[];
}

/** A local change that lost to a newer library file: the local bytes were saved as `conflictPath`. */
export interface SyncConflict {
  conflictPath: string;
  path: string;
}

export interface SyncOutResult {
  conflicts: SyncConflict[];
  /** Files deleted from the library. */
  deleted: string[];
  /** Local deletes that did not run because the library file changed. */
  deleteSkipped: string[];
  failed: SyncFailure[];
  /** Files over the size limit. */
  skipped: string[];
  /** Files written to the library. */
  written: string[];
}

/** The library path of the conflict copy of `path` made by run `runId`. */
export const conflictPathOf = (path: string, runId: string): string =>
  `${path}.conflict-${runId}`;

const CONFLICT_NAME = /\.conflict-[^/]+$/;

/** Whether a library path is a conflict copy. */
export const isConflictPath = (path: string): boolean =>
  CONFLICT_NAME.test(path);
