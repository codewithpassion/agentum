/**
 * A just-bash filesystem over the workspace library. Every call goes through
 * `LibraryOps`, the library service with the principal already bound, so this
 * file knows nothing about the principal, the database or blob storage.
 *
 * Each `ops` call counts as one storage call. A command gets a budget of them;
 * once it is spent, every further call fails with EIO and the command stops.
 */
import { isForbiddenError } from "@repo/services/authz";
import { isServiceError } from "@repo/services/errors";
import type { LibraryEntry } from "@repo/services/library";
import type {
  CpOptions,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  RmOptions,
} from "just-bash/browser";

export interface LibraryOps {
  list: (dir: string) => Promise<LibraryEntry[]>;
  mkdir: (path: string) => Promise<LibraryEntry>;
  move: (from: string, to: string) => Promise<LibraryEntry>;
  read: (path: string) => Promise<{ bytes: Uint8Array; entry: LibraryEntry }>;
  remove: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  stat: (path: string) => Promise<LibraryEntry>;
  write: (
    path: string,
    bytes: Uint8Array,
    options?: { ifEtag?: string }
  ) => Promise<LibraryEntry>;
}

export const STORAGE_BUDGET_MESSAGE = (budget: number): string =>
  `Storage call budget of ${budget} exceeded for this tool call. The command was stopped. Do less per call, for example work on fewer files or narrower paths.`;

/** A write that lost a race is retried with a fresh read, this many times in all. */
const APPEND_ATTEMPTS = 3;

/** The shape just-bash's `readdirWithFileTypes` returns. It is not exported from its browser entry. */
interface DirentEntry {
  isDirectory: boolean;
  isFile: boolean;
  isSymbolicLink: boolean;
  name: string;
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/** Resolves `.` and `..` against the root, so a `..` at the root stays there. */
const clamp = (path: string): string => {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return `/${parts.join("/")}`;
};

/** The service takes no leading slash, and the root is the empty string. */
const toLibraryPath = (absolute: string): string => absolute.slice(1);

const parentOf = (absolute: string): string =>
  absolute.slice(0, absolute.lastIndexOf("/")) || "/";

const lastSegment = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

const toBytes = (content: FileContent): Uint8Array =>
  typeof content === "string" ? ENCODER.encode(content) : content;

const concatBytes = (first: Uint8Array, second: Uint8Array): Uint8Array => {
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first);
  joined.set(second, first.byteLength);
  return joined;
};

const fsError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const invalidError = (message: string, at: string): Error => {
  if (
    message === "Path is a folder" ||
    message === "The library root is a folder"
  ) {
    return fsError("EISDIR", `EISDIR: illegal operation on a directory, ${at}`);
  }
  if (message === "A file is in the way of this path") {
    return fsError("ENOTDIR", `ENOTDIR: not a directory, ${at}`);
  }
  if (message.includes("limited to")) {
    return fsError("EFBIG", `EFBIG: file too large, ${at}`);
  }
  return fsError("EINVAL", `EINVAL: invalid argument, ${at}: ${message}`);
};

/** The fs error for a conflict, or null when the message is not one we map. */
const conflictError = (message: string, at: string): Error | null => {
  if (message === "The folder is not empty") {
    return fsError("ENOTEMPTY", `ENOTEMPTY: directory not empty, ${at}`);
  }
  if (message === "The destination exists") {
    return fsError("EEXIST", `EEXIST: file already exists, ${at}`);
  }
  if (message === "The file changed since it was read") {
    return fsError("EAGAIN", `EAGAIN: resource temporarily unavailable, ${at}`);
  }
  return null;
};

/** The fs error for a library failure, or null for one that is not ours to map. */
const toFsError = (error: unknown, op: string, path: string): Error | null => {
  const at = `${op} '${path}'`;
  if (isForbiddenError(error)) {
    return fsError("EACCES", `EACCES: permission denied, ${at}`);
  }
  if (!isServiceError(error)) {
    return null;
  }
  if (error.code === "not_found") {
    return fsError("ENOENT", `ENOENT: no such file or directory, ${at}`);
  }
  if (error.code === "invalid") {
    return invalidError(error.message, at);
  }
  return conflictError(error.message, at);
};

const statOf = (absolute: string, entry: LibraryEntry): FsStat => ({
  identity: `library:${absolute}`,
  isDirectory: entry.kind === "dir",
  isFile: entry.kind === "file",
  isSymbolicLink: false,
  mode: entry.kind === "dir" ? 0o755 : 0o644,
  mtime: new Date(entry.mtime),
  size: entry.size,
});

const direntOf = (entry: LibraryEntry): DirentEntry => ({
  isDirectory: entry.kind === "dir",
  isFile: entry.kind === "file",
  isSymbolicLink: false,
  name: lastSegment(entry.path),
});

const byName = (a: DirentEntry, b: DirentEntry): number => {
  if (a.name < b.name) {
    return -1;
  }
  return a.name > b.name ? 1 : 0;
};

const notSupported = (op: string, path: string): Promise<never> =>
  Promise.reject(
    fsError("ENOSYS", `ENOSYS: function not implemented, ${op} '${path}'`)
  );

export const createLibraryFs = ({
  ops,
  budget,
  onBudgetExceeded,
}: {
  ops: LibraryOps;
  budget: number;
  onBudgetExceeded?: () => void;
}): {
  fs: IFileSystem;
  storageCalls: () => number;
  budgetExceeded: () => boolean;
} => {
  let calls = 0;
  let exceeded = false;

  /** Runs one library call. Refuses it once the budget is spent, and maps its errors. */
  const spend = async <T>(
    op: string,
    path: string,
    task: () => Promise<T>
  ): Promise<T> => {
    if (calls >= budget) {
      if (!exceeded) {
        exceeded = true;
        onBudgetExceeded?.();
      }
      throw fsError("EIO", STORAGE_BUDGET_MESSAGE(budget));
    }
    calls += 1;
    try {
      return await task();
    } catch (error) {
      const mapped = toFsError(error, op, path);
      if (mapped) {
        throw mapped;
      }
      // Say nothing of the failure to the script: a database or R2 message is not for the model.
      console.error("Library storage failed", error);
      throw fsError("EIO", `EIO: input/output error, ${op} '${path}'`);
    }
  };

  /** The entry at `absolute`, or null when there is none. */
  const lookup = async (absolute: string): Promise<LibraryEntry | null> => {
    try {
      return await spend("stat", absolute, () =>
        ops.stat(toLibraryPath(absolute))
      );
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  };

  const readBytes = async (absolute: string): Promise<Uint8Array> => {
    if (absolute === "/") {
      throw fsError(
        "EISDIR",
        "EISDIR: illegal operation on a directory, open '/'"
      );
    }
    const { bytes } = await spend("open", absolute, () =>
      ops.read(toLibraryPath(absolute))
    );
    return bytes;
  };

  const readEntries = async (absolute: string): Promise<DirentEntry[]> => {
    const entries = await spend("scandir", absolute, () =>
      ops.list(toLibraryPath(absolute))
    );
    return entries.map(direntOf).sort(byName);
  };

  const mkdirRecursive = async (absolute: string): Promise<void> => {
    try {
      await spend("mkdir", absolute, () => ops.mkdir(toLibraryPath(absolute)));
    } catch (error) {
      if (!hasCode(error, "ENOTDIR")) {
        throw error;
      }
      const target = await lookup(absolute);
      if (target?.kind === "file") {
        throw fsError(
          "EEXIST",
          `EEXIST: file already exists, mkdir '${absolute}'`
        );
      }
      throw error;
    }
  };

  const copyFile = async (from: string, to: string): Promise<void> => {
    const bytes = await readBytes(from);
    await spend("open", to, () => ops.write(toLibraryPath(to), bytes));
  };

  /** Copies a folder's children one at a time, so at most one file is in memory. */
  const copyTree = async (from: string, to: string): Promise<void> => {
    await mkdirRecursive(to);
    const children = await readEntries(from);
    for (const child of children) {
      // biome-ignore lint/performance/noAwaitInLoops: one file in memory at a time
      await copyNode(
        clamp(`${from}/${child.name}`),
        clamp(`${to}/${child.name}`),
        child.isDirectory
      );
    }
  };

  const copyNode = (
    from: string,
    to: string,
    isDirectory: boolean
  ): Promise<void> => (isDirectory ? copyTree(from, to) : copyFile(from, to));

  /** The bytes and etag of a file, or null when there is no file. */
  const readExisting = async (
    absolute: string
  ): Promise<{ bytes: Uint8Array; etag: string | undefined } | null> => {
    try {
      const { bytes, entry } = await spend("open", absolute, () =>
        ops.read(toLibraryPath(absolute))
      );
      return { bytes, etag: entry.etag ?? undefined };
    } catch (error) {
      if (hasCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    }
  };

  const appendOnce = async (
    absolute: string,
    added: Uint8Array,
    attempt: number
  ): Promise<void> => {
    const current = await readExisting(absolute);
    const next = concatBytes(current?.bytes ?? new Uint8Array(), added);
    const ifEtag = current?.etag;
    try {
      await spend("open", absolute, () =>
        ops.write(
          toLibraryPath(absolute),
          next,
          ifEtag === undefined ? undefined : { ifEtag }
        )
      );
    } catch (error) {
      if (hasCode(error, "EAGAIN") && attempt < APPEND_ATTEMPTS) {
        return appendOnce(absolute, added, attempt + 1);
      }
      throw error;
    }
  };

  const fs: IFileSystem = {
    appendFile: (path, content) => appendOnce(clamp(path), toBytes(content), 1),

    // Files have one mode here. cp and mv from scratch call chmod, so it must not fail.
    chmod: () => Promise.resolve(),

    cp: async (src, dest, options?: CpOptions) => {
      const from = clamp(src);
      const to = clamp(dest);
      const entry = await spend("stat", from, () =>
        ops.stat(toLibraryPath(from))
      );
      if (entry.kind === "file") {
        await copyFile(from, to);
        return;
      }
      if (options?.recursive !== true) {
        throw fsError(
          "EISDIR",
          `EISDIR: illegal operation on a directory, cp '${from}'`
        );
      }
      await copyTree(from, to);
    },

    exists: async (path) => (await lookup(clamp(path))) !== null,

    getAllPaths: () => [],

    link: (_existing, newPath) => notSupported("link", clamp(newPath)),

    lstat: (path) => fs.stat(path),

    mkdir: async (path, options?: MkdirOptions) => {
      const absolute = clamp(path);
      if (options?.recursive === true) {
        await mkdirRecursive(absolute);
        return;
      }
      if (await lookup(absolute)) {
        throw fsError(
          "EEXIST",
          `EEXIST: file already exists, mkdir '${absolute}'`
        );
      }
      const parent = await lookup(parentOf(absolute));
      if (!parent) {
        throw fsError(
          "ENOENT",
          `ENOENT: no such file or directory, mkdir '${absolute}'`
        );
      }
      if (parent.kind === "file") {
        throw fsError(
          "ENOTDIR",
          `ENOTDIR: not a directory, mkdir '${absolute}'`
        );
      }
      await spend("mkdir", absolute, () => ops.mkdir(toLibraryPath(absolute)));
    },

    mv: async (src, dest) => {
      const from = clamp(src);
      const to = clamp(dest);
      await spend("rename", from, () =>
        ops.move(toLibraryPath(from), toLibraryPath(to))
      );
    },

    readdir: async (path) =>
      (await readEntries(clamp(path))).map((entry) => entry.name),

    readdirWithFileTypes: (path) => readEntries(clamp(path)),

    readFile: async (path) => DECODER.decode(await readBytes(clamp(path))),
    readFileBuffer: (path) => readBytes(clamp(path)),

    readlink: (path) =>
      Promise.reject(
        fsError("EINVAL", `EINVAL: invalid argument, readlink '${clamp(path)}'`)
      ),

    realpath: async (path) => {
      const absolute = clamp(path);
      await spend("stat", absolute, () => ops.stat(toLibraryPath(absolute)));
      return absolute;
    },

    resolvePath: (base, path) =>
      clamp(path.startsWith("/") ? path : `${base}/${path}`),

    rm: async (path, options?: RmOptions) => {
      const absolute = clamp(path);
      try {
        await spend("rm", absolute, () =>
          ops.remove(toLibraryPath(absolute), {
            recursive: options?.recursive === true,
          })
        );
      } catch (error) {
        if (options?.force === true && hasCode(error, "ENOENT")) {
          return;
        }
        throw error;
      }
    },

    stat: async (path) => {
      const absolute = clamp(path);
      const entry = await spend("stat", absolute, () =>
        ops.stat(toLibraryPath(absolute))
      );
      return statOf(absolute, entry);
    },

    symlink: (_target, linkPath) => notSupported("symlink", clamp(linkPath)),

    utimes: () => Promise.resolve(),

    writeFile: async (path, content) => {
      const absolute = clamp(path);
      await spend("open", absolute, () =>
        ops.write(toLibraryPath(absolute), toBytes(content))
      );
    },
  };

  return {
    budgetExceeded: () => exceeded,
    fs,
    storageCalls: () => calls,
  };
};
