// Sends local changes to the library. Each write is a compare-and-swap on the
// etag from the last sync. A write that loses the race becomes a conflict copy
// in the library, and the library's file is kept.
import {
  cleanRoots,
  describe,
  inScope,
  openManifest,
  sha256Of,
  walkLocal,
} from "./files.ts";
import {
  conflictPathOf,
  SYNC_MAX_FILE_BYTES,
  type SyncConflict,
  type SyncFailure,
  type SyncOutOptions,
  type SyncOutResult,
  type SyncPorts,
} from "./types.ts";

const byPath = (a: string, b: string): number => a.localeCompare(b);

export const runSyncOut = async (
  ports: SyncPorts,
  options: SyncOutOptions
): Promise<SyncOutResult> => {
  const { local, remote } = ports;
  const roots = cleanRoots(options.roots);
  const max = options.maxFileBytes ?? SYNC_MAX_FILE_BYTES;
  const { entries, save } = await openManifest(ports.manifest);
  const localFiles = (await walkLocal(local, roots)).sort((a, b) =>
    byPath(a.path, b.path)
  );
  const localPaths = new Set(localFiles.map((file) => file.path));

  const conflicts: SyncConflict[] = [];
  const deleted: string[] = [];
  const deleteSkipped: string[] = [];
  const failed: SyncFailure[] = [];
  const skipped: string[] = [];
  const written: string[] = [];

  const keep = async (path: string, etag: string, sha256: string) => {
    entries.set(path, { etag, path, sha256 });
    await save();
  };

  const conflict = async (
    path: string,
    bytes: Uint8Array,
    hash: string
  ): Promise<void> => {
    const copyPath = conflictPathOf(path, options.runId);
    const copy = await remote.write(copyPath, bytes);
    if (!copy) {
      throw new Error(`write ${copyPath} returned no etag`);
    }
    conflicts.push({ conflictPath: copyPath, path });
    entries.set(copyPath, { etag: copy.etag, path: copyPath, sha256: hash });
    localPaths.add(copyPath);
    await local.write(copyPath, bytes);

    const current = await remote.read(path);
    if (current) {
      // Take the library's bytes only if the agent has not edited the file meanwhile.
      const localNow = await sha256Of(await local.read(path));
      if (localNow === hash) {
        await local.write(path, current.bytes);
        await keep(path, current.etag, await sha256Of(current.bytes));
      }
    } else {
      entries.delete(path);
    }
    await save();
  };

  const syncFile = async (path: string, size: number): Promise<void> => {
    if (size > max) {
      skipped.push(path);
      return;
    }
    const bytes = await local.read(path);
    const hash = await sha256Of(bytes);
    const entry = entries.get(path);
    if (entry?.sha256 === hash) {
      return;
    }
    if (entry) {
      const stored = await remote.write(path, bytes, { ifEtag: entry.etag });
      if (stored) {
        await keep(path, stored.etag, hash);
        written.push(path);
      } else {
        await conflict(path, bytes, hash);
      }
      return;
    }
    if (await remote.stat(path)) {
      await conflict(path, bytes, hash);
      return;
    }
    const stored = await remote.write(path, bytes);
    if (!stored) {
      throw new Error(`write ${path} returned no etag`);
    }
    await keep(path, stored.etag, hash);
    written.push(path);
  };

  for (const file of localFiles) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one file at a time keeps each compare-and-swap and its manifest save in order
      await syncFile(file.path, file.size);
    } catch (error) {
      failed.push({ message: describe(error), path: file.path });
    }
  }

  const localDeletes = [...entries.values()]
    .filter(
      (entry) => inScope(entry.path, roots) && !localPaths.has(entry.path)
    )
    .sort((a, b) => byPath(a.path, b.path));
  for (const gone of localDeletes) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one delete at a time keeps the manifest save in step
      const existing = await remote.stat(gone.path);
      if (existing?.kind === "file" && existing.etag === gone.etag) {
        await remote.delete(gone.path);
        deleted.push(gone.path);
      } else if (existing) {
        deleteSkipped.push(gone.path);
      }
      entries.delete(gone.path);
      await save();
    } catch (error) {
      failed.push({ message: describe(error), path: gone.path });
    }
  }

  await save();
  return {
    conflicts: conflicts.sort((a, b) => byPath(a.path, b.path)),
    deleted: deleted.sort(byPath),
    deleteSkipped: deleteSkipped.sort(byPath),
    failed: failed.sort((a, b) => byPath(a.path, b.path)),
    skipped: skipped.sort(byPath),
    written: written.sort(byPath),
  };
};
