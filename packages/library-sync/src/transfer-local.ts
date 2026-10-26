// The local side of the library sync on a real disk: a working copy under one
// folder, and a manifest file beside it. Links are never followed when listing
// or stating, and a path that leaves the folder is refused before the disk is
// touched.

import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import type {
  LocalEntry,
  LocalPort,
  ManifestEntry,
  ManifestStore,
} from "./types.ts";

type Kind = "dir" | "file";

const MISSING_ERRORS = new Set(["ENOENT", "ENOTDIR"]);

const isMissing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  MISSING_ERRORS.has(String(error.code));

/** Runs `work`, or gives null when the path is not there. */
const orNull = async <T>(work: () => Promise<T>): Promise<T | null> => {
  try {
    return await work();
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
};

const kindOf = (entry: {
  isDirectory: () => boolean;
  isFile: () => boolean;
}): Kind | null => {
  if (entry.isFile()) {
    return "file";
  }
  return entry.isDirectory() ? "dir" : null;
};

/**
 * The absolute path of a library path under `dir`. The empty path is `dir`
 * itself. A path that is absolute, has a NUL or a `..` segment, or lands
 * outside `dir` throws.
 */
const pathUnder = (dir: string, path: string): string => {
  const root = resolve(dir);
  if (path === "") {
    return root;
  }
  if (
    isAbsolute(path) ||
    path.includes("\0") ||
    path.split("/").includes("..")
  ) {
    throw new Error(`${path} is not a path inside the working copy`);
  }
  const target = resolve(root, path);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`${path} is not a path inside the working copy`);
  }
  return target;
};

/** The absolute path of a file under `dir`. The folder itself is refused too. */
const filePathUnder = (dir: string, path: string): string => {
  const target = pathUnder(dir, path);
  if (target === resolve(dir)) {
    throw new Error(`${path} names the working copy folder, not a file`);
  }
  return target;
};

/** A local port for the working copy in folder `dir`. Library paths map to `<dir>/<path>`. */
export const createDiskLocal = (dir: string): LocalPort => ({
  list: async (path) => {
    const abs = pathUnder(dir, path);
    const folder = await orNull(() => lstat(abs));
    if (folder === null || !folder.isDirectory()) {
      return [];
    }
    const entries = await orNull(() => readdir(abs, { withFileTypes: true }));
    return (entries ?? []).flatMap((entry): LocalEntry[] => {
      const kind = kindOf(entry);
      return kind === null ? [] : [{ kind, name: entry.name }];
    });
  },
  read: async (path) => readFile(filePathUnder(dir, path)),
  remove: async (path) => {
    await orNull(() => rm(filePathUnder(dir, path), { force: true }));
  },
  stat: async (path) => {
    const entry = await orNull(() => lstat(pathUnder(dir, path)));
    if (entry === null) {
      return null;
    }
    const kind = kindOf(entry);
    return kind === null ? null : { kind, size: entry.size };
  },
  write: async (path, bytes) => {
    const target = filePathUnder(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  },
});

const isManifestEntry = (value: unknown): value is ManifestEntry =>
  typeof value === "object" &&
  value !== null &&
  "etag" in value &&
  typeof value.etag === "string" &&
  "path" in value &&
  typeof value.path === "string" &&
  "sha256" in value &&
  typeof value.sha256 === "string";

/** The manifest kept as JSON in `file`. A missing or unreadable-as-JSON file loads as empty. */
export const createFileManifest = (file: string): ManifestStore => ({
  load: async () => {
    const text = await orNull(() => readFile(file, "utf8"));
    if (text === null) {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) {
      return [];
    }
    const items: unknown[] = parsed;
    return items
      .filter(isManifestEntry)
      .map(({ etag, path, sha256 }) => ({ etag, path, sha256 }));
  },
  save: async (entries) => {
    await mkdir(dirname(file), { recursive: true });
    // Write beside the file and rename it into place, so a crash keeps the old manifest.
    const temp = `${file}.tmp`;
    await writeFile(temp, JSON.stringify(entries));
    await rename(temp, file);
  },
});
