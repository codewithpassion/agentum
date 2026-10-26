/**
 * The library sync of a Linux VM. `@repo/library-sync` does the work; this
 * file builds its ports from the VM and from the library service, and wraps it
 * for `PiRun`. A run copies the agent's folder and its library paths into the
 * VM when it starts, and sends the changes back when it ends. Neither call
 * throws: a failed sync is logged, and the run goes on.
 */
import {
  createLibrarySync,
  type LocalEntry,
  type LocalPort,
  type ManifestStore,
  type RemotePort,
} from "@repo/library-sync";
import { isServiceError } from "@repo/services/errors";
import { agentHomePath } from "@repo/services/library/home";
import { librarySyncRoots } from "@repo/services/library/sync-paths";
import type { LibraryOps } from "../library-bash/library-fs.ts";
import type { RunStorage } from "../pi-run-core.ts";
import {
  type LinuxVm,
  VM_LIBRARY_DIR,
  VM_LIBRARY_MANIFEST,
  VmFileError,
} from "./vm-port.ts";

/** The key of the sync state in the run's storage. */
export const LIBRARY_SYNC_KEY = "library-sync";

/** What a run keeps between its start and its end. The prompt reads `conflicts`. */
export interface LibrarySyncState {
  /** Library paths of conflict copies that wait for the agent. */
  conflicts: string[];
  /** Whether the last sync in finished, so the prompt may say the VM holds a copy. */
  ready: boolean;
  /** The library paths the run syncs. */
  roots: string[];
}

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isMissingFile = (error: unknown): boolean =>
  error instanceof VmFileError &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

/** The VM path of a library path. The empty string is the library root. */
const vmPathOf = (root: string, path: string): string =>
  path === "" ? root : `${root}/${path}`;

/** The library port of a working copy under `root` in the VM. */
export const vmLocalPort = (vm: LinuxVm, root = VM_LIBRARY_DIR): LocalPort => {
  const absolute = (path: string) => vmPathOf(root, path);
  return {
    list: async (dir) => {
      try {
        const entries = await vm.list(absolute(dir));
        return entries
          .filter((entry) => entry.kind !== "symlink")
          .map(
            (entry): LocalEntry => ({
              kind: entry.kind === "directory" ? "dir" : "file",
              name: entry.name,
            })
          );
      } catch (error) {
        if (isMissingFile(error)) {
          return [];
        }
        throw error;
      }
    },
    read: (path) => vm.readFile(absolute(path)),
    remove: (path) => vm.remove(absolute(path), { force: true }),
    stat: async (path) => {
      try {
        const stat = await vm.stat(absolute(path));
        if (stat.kind === "symlink") {
          return null;
        }
        return {
          kind: stat.kind === "directory" ? "dir" : "file",
          size: stat.size,
        };
      } catch (error) {
        if (isMissingFile(error)) {
          return null;
        }
        throw error;
      }
    },
    write: async (path, bytes) => {
      const target = absolute(path);
      await vm.mkdir(target.slice(0, target.lastIndexOf("/")), {
        recursive: true,
      });
      await vm.writeFile(target, bytes);
    },
  };
};

const isManifestEntry = (
  value: unknown
): value is { etag: string; path: string; sha256: string } =>
  typeof value === "object" &&
  value !== null &&
  "etag" in value &&
  typeof value.etag === "string" &&
  "path" in value &&
  typeof value.path === "string" &&
  "sha256" in value &&
  typeof value.sha256 === "string";

/** The manifest of the working copy, kept in the VM beside it. */
export const vmManifestStore = (
  vm: LinuxVm,
  path = VM_LIBRARY_MANIFEST
): ManifestStore => ({
  load: async () => {
    let text: string;
    try {
      text = TEXT_DECODER.decode(await vm.readFile(path));
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    return Array.isArray(parsed) ? parsed.filter(isManifestEntry) : [];
  },
  save: (entries) =>
    vm.writeFile(path, TEXT_ENCODER.encode(JSON.stringify(entries))),
});

/** The remote port of the workspace library, with the caller's principal already bound. */
export const libraryRemotePort = (
  ops: Pick<LibraryOps, "list" | "read" | "remove" | "stat" | "write">
): RemotePort => ({
  delete: async (path) => {
    try {
      await ops.remove(path);
    } catch (error) {
      if (!(isServiceError(error) && error.code === "not_found")) {
        throw error;
      }
    }
  },
  list: async (dir) => {
    try {
      const entries = await ops.list(dir);
      return entries.map((entry) => ({
        etag: entry.etag,
        kind: entry.kind,
        path: entry.path,
        size: entry.size,
      }));
    } catch (error) {
      if (isServiceError(error) && error.code === "not_found") {
        return [];
      }
      throw error;
    }
  },
  read: async (path) => {
    try {
      const { bytes, entry } = await ops.read(path);
      if (entry.etag === null) {
        throw new Error(`The library file ${path} has no etag`);
      }
      return { bytes, etag: entry.etag };
    } catch (error) {
      if (
        isServiceError(error) &&
        (error.code === "not_found" || error.code === "invalid")
      ) {
        return null;
      }
      throw error;
    }
  },
  stat: async (path) => {
    try {
      const entry = await ops.stat(path);
      return {
        etag: entry.etag,
        kind: entry.kind,
        path: entry.path,
        size: entry.size,
      };
    } catch (error) {
      if (isServiceError(error) && error.code === "not_found") {
        return null;
      }
      throw error;
    }
  },
  write: async (path, bytes, options) => {
    try {
      const written = await ops.write(
        path,
        bytes,
        options?.ifEtag === undefined ? undefined : { ifEtag: options.ifEtag }
      );
      if (written.etag === null) {
        throw new Error(`The library did not return an etag for ${path}`);
      }
      return { etag: written.etag };
    } catch (error) {
      if (isServiceError(error) && error.code === "conflict") {
        return null;
      }
      throw error;
    }
  },
});

const LOCK_RETRY_MS = 250;
const LOCK_WAIT_MS = 30_000;
/** A sync takes seconds and renews its hold while it runs, so a hold this old belongs to a sync that died, for example with its Durable Object. */
const LOCK_TTL_MS = 300_000;
const RENEWALS_PER_TTL = 3;

const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

interface LockOptions {
  now?: () => number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
  ttlMs?: number;
  waitMs?: number;
}

/**
 * Runs `work` while this call holds the VM's library lock. Sessions of one
 * agent share the VM, its working copy and its manifest, so their syncs take
 * turns through the VM's Durable Object (`lockLibrary`). Waits up to `waitMs`
 * for the holder, then throws. The hold is renewed while the work runs and expires `ttlMs` after the last renewal, and the release
 * gives back only this call's own hold.
 */
export const withLibraryLock = async <T>(
  vm: LinuxVm,
  work: () => Promise<T>,
  {
    now = Date.now,
    retryMs = LOCK_RETRY_MS,
    sleep = realSleep,
    ttlMs = LOCK_TTL_MS,
    waitMs = LOCK_WAIT_MS,
  }: LockOptions = {}
): Promise<T> => {
  const owner = crypto.randomUUID();
  const giveUpAt = now() + waitMs;
  // biome-ignore lint/performance/noAwaitInLoops: each try follows the failure of the one before
  while (!(await vm.lockLibrary(owner, ttlMs))) {
    if (now() >= giveUpAt) {
      throw new Error("Another sync holds the library lock");
    }
    await sleep(retryMs);
  }
  // A long sync renews its hold, so only a sync that died loses it.
  const renewal = setInterval(() => {
    vm.lockLibrary(owner, ttlMs).catch(() => undefined);
  }, ttlMs / RENEWALS_PER_TTL);
  try {
    return await work();
  } finally {
    clearInterval(renewal);
    await vm.unlockLibrary(owner).catch((error: unknown) => {
      console.warn(
        "PiRun: giving back the library lock failed, it ends by itself",
        messageOf(error)
      );
    });
  }
};

/** The sync state a run kept, or undefined when the run has not synced yet. */
export const libraryStateOf = (
  storage: Pick<RunStorage, "get">
): Promise<LibrarySyncState | undefined> =>
  storage.get<LibrarySyncState>(LIBRARY_SYNC_KEY);

/** What the prompt says about the working copy: nothing until a sync in has finished. */
export const libraryCopyOf = async (
  storage: Pick<RunStorage, "get">
): Promise<{ conflicts: string[]; roots: string[] } | undefined> => {
  const state = await libraryStateOf(storage);
  return state?.ready
    ? { conflicts: state.conflicts, roots: state.roots }
    : undefined;
};

/** Copies the agent's folder and its library paths into the VM. Never throws. */
export const syncLibraryIn = async (input: {
  ops: Pick<LibraryOps, "list" | "read" | "remove" | "stat" | "write">;
  runtimeConfig: Record<string, unknown>;
  slug: string;
  storage: Pick<RunStorage, "get" | "put">;
  vm: LinuxVm;
}): Promise<void> => {
  try {
    const roots = librarySyncRoots(input.slug, input.runtimeConfig);
    const previous = await libraryStateOf(input.storage);
    const conflicts = previous ? previous.conflicts : [];
    // Saved first, so the end of the run can sync out even when this fails.
    await input.storage.put<LibrarySyncState>(LIBRARY_SYNC_KEY, {
      conflicts,
      ready: false,
      roots,
    });
    const result = await withLibraryLock(input.vm, async () => {
      await input.vm.mkdir(`${VM_LIBRARY_DIR}/${agentHomePath(input.slug)}`, {
        recursive: true,
      });
      return await createLibrarySync({
        local: vmLocalPort(input.vm),
        manifest: vmManifestStore(input.vm),
        remote: libraryRemotePort(input.ops),
      }).syncIn({ roots: roots.map((path) => ({ mode: "write", path })) });
    });
    await input.storage.put<LibrarySyncState>(LIBRARY_SYNC_KEY, {
      conflicts: result.conflicts,
      ready: true,
      roots,
    });
    if (result.failed.length > 0) {
      console.warn(
        `PiRun: ${result.failed.length} library file(s) did not sync into the VM: ${result.failed.map((failure) => failure.path).join(", ")}`
      );
    }
  } catch (error) {
    console.warn(
      "PiRun: syncing the library into the VM failed",
      messageOf(error)
    );
  }
};

/** Sends the VM's changes back to the library and records each conflict. Never throws. */
export const syncLibraryOut = async (input: {
  ops: Pick<LibraryOps, "list" | "read" | "remove" | "stat" | "write">;
  recordConflict: (conflict: {
    conflictPath: string;
    path: string;
  }) => Promise<void>;
  runId: string;
  storage: Pick<RunStorage, "get">;
  vm: LinuxVm;
}): Promise<void> => {
  try {
    const state = await libraryStateOf(input.storage);
    if (state === undefined) {
      return;
    }
    const result = await withLibraryLock(input.vm, () =>
      createLibrarySync({
        local: vmLocalPort(input.vm),
        manifest: vmManifestStore(input.vm),
        remote: libraryRemotePort(input.ops),
      }).syncOut({
        roots: state.roots.map((path) => ({ mode: "write", path })),
        runId: input.runId,
      })
    );
    await Promise.all(
      result.conflicts.map(async (conflict) => {
        try {
          await input.recordConflict(conflict);
        } catch (error) {
          console.warn(
            `PiRun: recording the library conflict for ${conflict.path} failed`,
            messageOf(error)
          );
        }
      })
    );
    if (result.failed.length > 0) {
      console.warn(
        `PiRun: ${result.failed.length} library file(s) did not sync out of the VM: ${result.failed.map((failure) => failure.path).join(", ")}`
      );
    }
  } catch (error) {
    console.warn(
      "PiRun: syncing the library out of the VM failed",
      messageOf(error)
    );
  }
};
