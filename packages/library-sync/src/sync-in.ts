// Copies the library into the working copy. A local edit that was not sent
// yet is never overwritten: such a file is listed in `kept` and left alone.
import {
  cleanRoots,
  describe,
  inScope,
  openManifest,
  sha256Of,
  walkRemote,
} from "./files.ts";
import {
  isConflictPath,
  type ManifestEntry,
  type RemoteEntry,
  SYNC_MAX_FILE_BYTES,
  type SyncFailure,
  type SyncInResult,
  type SyncOptions,
  type SyncPorts,
} from "./types.ts";

const compare = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

const FOLDER_IN_THE_WAY = "A folder is in the way";

export const runSyncIn = async (
  ports: SyncPorts,
  options: SyncOptions
): Promise<SyncInResult> => {
  const { local, remote } = ports;
  const roots = cleanRoots(options.roots);
  const max = options.maxFileBytes ?? SYNC_MAX_FILE_BYTES;
  const { entries, save } = await openManifest(ports.manifest);
  const remoteFiles = [...(await walkRemote(remote, roots))].sort((a, b) =>
    compare(a.path, b.path)
  );
  const remotePaths = new Set(remoteFiles.map((file) => file.path));

  const result: SyncInResult = {
    conflicts: [],
    failed: [],
    kept: [],
    pulled: [],
    removed: [],
    skipped: [],
  };

  /** `unchanged` is the hash the local file had when it was judged unedited, checked again just before it is replaced. */
  const pull = async (path: string, unchanged?: string): Promise<void> => {
    const read = await remote.read(path);
    if (read === null) {
      return;
    }
    if (read.bytes.byteLength > max) {
      result.skipped.push(path);
      return;
    }
    if (
      unchanged !== undefined &&
      (await sha256Of(await local.read(path))) !== unchanged
    ) {
      result.kept.push(path);
      return;
    }
    await local.write(path, read.bytes);
    entries.set(path, {
      etag: read.etag,
      path,
      sha256: await sha256Of(read.bytes),
    });
    result.pulled.push(path);
    await save();
  };

  const syncFile = async (file: RemoteEntry): Promise<void> => {
    const { path } = file;
    if (file.size > max) {
      result.skipped.push(path);
      return;
    }
    const entry = entries.get(path);
    if (entry?.etag === file.etag) {
      return;
    }
    const stat = await local.stat(path);
    if (stat?.kind === "dir") {
      result.failed.push({ message: FOLDER_IN_THE_WAY, path });
      return;
    }
    if (stat === null) {
      if (entry) {
        result.kept.push(path);
      } else {
        await pull(path);
      }
      return;
    }
    const localHash = await sha256Of(await local.read(path));
    if (entry) {
      if (localHash === entry.sha256) {
        await pull(path, localHash);
      } else {
        result.kept.push(path);
      }
      return;
    }
    const read = await remote.read(path);
    if (read === null) {
      return;
    }
    if ((await sha256Of(read.bytes)) === localHash) {
      entries.set(path, { etag: read.etag, path, sha256: localHash });
      await save();
    } else {
      result.kept.push(path);
    }
  };

  const dropGone = async (entry: ManifestEntry): Promise<void> => {
    const { path } = entry;
    const stat = await local.stat(path);
    if (stat === null) {
      entries.delete(path);
      return;
    }
    if (stat.kind === "dir") {
      result.failed.push({ message: FOLDER_IN_THE_WAY, path });
      return;
    }
    const localHash = await sha256Of(await local.read(path));
    if (localHash === entry.sha256) {
      await local.remove(path);
      result.removed.push(path);
    } else {
      result.kept.push(path);
    }
    entries.delete(path);
  };

  const attempt = async (
    path: string,
    work: () => Promise<void>
  ): Promise<void> => {
    try {
      await work();
    } catch (error) {
      const failure: SyncFailure = { message: describe(error), path };
      result.failed.push(failure);
    }
  };

  for (const file of remoteFiles) {
    // biome-ignore lint/performance/noAwaitInLoops: one file at a time keeps the manifest and the local writes in order
    await attempt(file.path, () => syncFile(file));
  }

  const gone = [...entries.values()].filter(
    (entry) => inScope(entry.path, roots) && !remotePaths.has(entry.path)
  );
  for (const entry of gone) {
    // biome-ignore lint/performance/noAwaitInLoops: one file at a time keeps the manifest and the local removes in order
    await attempt(entry.path, () => dropGone(entry));
  }

  await save();

  result.conflicts = remoteFiles
    .map((file) => file.path)
    .filter((path) => isConflictPath(path));
  result.conflicts.sort(compare);
  result.failed.sort((a, b) => compare(a.path, b.path));
  result.kept.sort(compare);
  result.pulled.sort(compare);
  result.removed.sort(compare);
  result.skipped.sort(compare);
  return result;
};
