// Helpers shared by sync in and sync out: hashing, the two tree walks, the
// scope check and the manifest kept as a map.
import type {
  LocalPort,
  ManifestEntry,
  ManifestStore,
  RemoteEntry,
  RemotePort,
} from "./types.ts";

const HEX_WIDTH = 2;

export const sha256Of = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes as Uint8Array<ArrayBuffer>
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(HEX_WIDTH, "0"))
    .join("");
};

export const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Whether `path` is a root or lies below one. */
export const inScope = (path: string, roots: readonly string[]): boolean =>
  roots.some((root) => path === root || path.startsWith(`${root}/`));

/** Roots with a trailing slash removed and duplicates dropped, so a root that holds another is walked once. */
export const cleanRoots = (roots: readonly string[]): string[] => {
  const trimmed = [
    ...new Set(roots.map((root) => root.replace(/^\/+|\/+$/g, ""))),
  ].filter((root) => root !== "");
  return trimmed.filter(
    (root) =>
      !trimmed.some((other) => other !== root && root.startsWith(`${other}/`))
  );
};

/** Every file of the library under the roots. A root may be a file or a folder, and one that is not there adds nothing. */
export const walkRemote = async (
  remote: RemotePort,
  roots: readonly string[]
): Promise<RemoteEntry[]> => {
  const files: RemoteEntry[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await remote.list(dir)) {
      if (entry.kind === "file") {
        files.push(entry);
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: one folder at a time keeps the number of open calls small
      await visit(entry.path);
    }
  };
  for (const root of roots) {
    // biome-ignore lint/performance/noAwaitInLoops: the roots are few
    const entry = await remote.stat(root);
    if (entry?.kind === "file") {
      files.push(entry);
    } else if (entry?.kind === "dir") {
      await visit(root);
    }
  }
  return files;
};

/** Every file of the working copy under the roots, as library paths with their sizes. */
export const walkLocal = async (
  local: LocalPort,
  roots: readonly string[]
): Promise<{ path: string; size: number }[]> => {
  const files: { path: string; size: number }[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await local.list(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.kind === "dir") {
        // biome-ignore lint/performance/noAwaitInLoops: one folder at a time
        await visit(path);
        continue;
      }
      const stat = await local.stat(path);
      if (stat?.kind === "file") {
        files.push({ path, size: stat.size });
      }
    }
  };
  for (const root of roots) {
    // biome-ignore lint/performance/noAwaitInLoops: the roots are few
    const stat = await local.stat(root);
    if (stat?.kind === "file") {
      files.push({ path: root, size: stat.size });
    } else if (stat?.kind === "dir") {
      await visit(root);
    }
  }
  return files;
};

/** The manifest as a map by path, saved whole after each change so a crash leaves it at most one file behind. */
export const openManifest = async (store: ManifestStore) => {
  const entries = new Map<string, ManifestEntry>(
    (await store.load()).map((entry) => [entry.path, entry])
  );
  const save = () => store.save([...entries.values()]);
  return { entries, save };
};
