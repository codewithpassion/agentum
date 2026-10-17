/**
 * An `ExecutionEnv` over the workspace library, so Pi's `read`, `write` and
 * `edit` tools work on library files. Only `/library` and the paths under it
 * exist. Every call goes through `LibraryOps`, the library service with the
 * principal bound, so this file knows nothing about the principal either.
 *
 * The library has no symbolic links, no shell and no temporary files. Readers
 * take a snapshot when they open, so a reader keeps working after its file is
 * renamed or removed.
 */
import type { Context } from "@earendil-works/chord";
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  err,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileWatcher,
  type LineScan,
  LineScanner,
  ok,
  type Result,
  type ShellExecResult,
  StreamDecoder,
  type TextLine,
  type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { LIBRARY_FILE_MAX_BYTES } from "@repo/db/shared";
import type { LibraryEntry } from "@repo/services/library";
import {
  clamp,
  type LibraryOps,
  libraryFsError,
} from "../library-bash/library-fs.ts";
import { LIBRARY_MOUNT } from "../library-bash/run.ts";

const ENV_ID_PREFIX = "harbourmaster:library:";
const ENCODER = new TextEncoder();
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

/** A write that lost a race is retried with a fresh read, this many times in all. */
const APPEND_ATTEMPTS = 3;

const ERRNO_CODES = new Map<string, FileErrorCode>([
  ["ENOENT", "not_found"],
  ["EACCES", "permission_denied"],
  ["ENOTDIR", "not_directory"],
  ["EISDIR", "is_directory"],
  ["ENOSYS", "not_supported"],
  ["EIO", "unknown"],
]);

/** The path of an absolute path, in the library: `""` for the root. */
interface Target {
  /** Absolute, under `/library`, with `.` and `..` resolved. */
  absolute: string;
  /** The service's path: no leading slash, `""` for the root. */
  library: string;
}

/** The contents of a file when it was read. */
interface Snapshot {
  bytes: Uint8Array;
  entry: LibraryEntry;
}

const lastSegment = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

const errnoOf = (error: Error): string | undefined =>
  "code" in error && typeof error.code === "string" ? error.code : undefined;

const absoluteOf = (cwd: string, path: string): string =>
  clamp(path.startsWith("/") ? path : `${cwd}/${path}`);

const targetOf = (absolute: string): Target | null => {
  if (absolute === LIBRARY_MOUNT) {
    return { absolute, library: "" };
  }
  if (absolute.startsWith(`${LIBRARY_MOUNT}/`)) {
    return {
      absolute,
      library: absolute.slice(LIBRARY_MOUNT.length + 1),
    };
  }
  return null;
};

const parentTarget = (target: Target): Target => {
  const cut = target.library.lastIndexOf("/");
  return {
    absolute: target.absolute.slice(0, target.absolute.lastIndexOf("/")),
    library: cut === -1 ? "" : target.library.slice(0, cut),
  };
};

const outsideLibrary = (absolute: string): FileError =>
  new FileError(
    "permission_denied",
    "Only paths under /library are available",
    absolute
  );

export const abortedError = (
  context: Context,
  path: string
): FileError | undefined =>
  context.abortSignal?.aborted
    ? new FileError("aborted", "aborted", path)
    : undefined;

/** Runs `task` for the library path of `path`, after the abort check and the /library check. */
const withTarget = <T>(
  cwd: string,
  path: string,
  context: Context,
  task: (target: Target) => Promise<Result<T, FileError>>
): Promise<Result<T, FileError>> => {
  const absolute = absoluteOf(cwd, path);
  const aborted = abortedError(context, absolute);
  if (aborted) {
    return Promise.resolve(err<T, FileError>(aborted));
  }
  const target = targetOf(absolute);
  if (target === null) {
    return Promise.resolve(err<T, FileError>(outsideLibrary(absolute)));
  }
  return task(target);
};

/** Maps the library error to a FileError. The errno error is kept as its cause, for the callers that retry. */
const toFileError = (mapped: Error, path: string): FileError =>
  new FileError(
    ERRNO_CODES.get(errnoOf(mapped) ?? "") ?? "invalid",
    mapped.message,
    path,
    mapped
  );

/** Runs one library call and maps its failure to a FileError. */
const callLibrary = async <T>(
  op: string,
  path: string,
  task: () => Promise<T>
): Promise<Result<T, FileError>> => {
  try {
    return ok(await task());
  } catch (error) {
    return err(toFileError(libraryFsError(error, op, path), path));
  }
};

const statEntry = (
  ops: LibraryOps,
  target: Target
): Promise<Result<LibraryEntry, FileError>> =>
  callLibrary("stat", target.absolute, () => ops.stat(target.library));

/** Reads the whole file once. A folder fails with is_directory, a missing path with not_found. */
const readSnapshot = (
  ops: LibraryOps,
  target: Target
): Promise<Result<Snapshot, FileError>> => {
  if (target.library === "") {
    return Promise.resolve(
      err(
        new FileError(
          "is_directory",
          `EISDIR: illegal operation on a directory, open '${target.absolute}'`,
          target.absolute
        )
      )
    );
  }
  return callLibrary("open", target.absolute, () => ops.read(target.library));
};

const toFileInfo = (absolute: string, entry: LibraryEntry): FileInfo => ({
  kind: entry.kind === "dir" ? "directory" : "file",
  mtimeMs: Date.parse(entry.mtime),
  name: lastSegment(absolute),
  path: absolute,
  size: entry.size,
});

const childInfos = (
  absolute: string,
  entries: readonly LibraryEntry[]
): FileInfo[] =>
  entries.map((entry) =>
    toFileInfo(`${absolute}/${lastSegment(entry.path)}`, entry)
  );

/**
 * The entries of a folder. The service answers not_found for a file too, so a
 * file is told apart here and fails with not_directory.
 */
const listEntries = async (
  ops: LibraryOps,
  target: Target
): Promise<Result<LibraryEntry[], FileError>> => {
  const listed = await callLibrary("scandir", target.absolute, () =>
    ops.list(target.library)
  );
  if (listed.ok || listed.error.code !== "not_found") {
    return listed;
  }
  const entry = await statEntry(ops, target);
  if (entry.ok && entry.value.kind === "file") {
    return err(
      new FileError(
        "not_directory",
        `ENOTDIR: not a directory, scandir '${target.absolute}'`,
        target.absolute
      )
    );
  }
  return listed;
};

/** Writes only over the version that was read, so a concurrent change fails instead of being lost. */
const ifUnchanged = (
  entry: LibraryEntry | undefined
): { ifEtag: string } | undefined =>
  entry?.etag ? { ifEtag: entry.etag } : undefined;

export const concatBytes = (
  first: Uint8Array,
  second: Uint8Array
): Uint8Array => {
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first);
  joined.set(second, first.byteLength);
  return joined;
};

const isEagain = (error: FileError): boolean =>
  error.cause instanceof Error && errnoOf(error.cause) === "EAGAIN";

const readIfPresent = async (
  ops: LibraryOps,
  target: Target
): Promise<Result<Snapshot | undefined, FileError>> => {
  const snapshot = await readSnapshot(ops, target);
  if (snapshot.ok) {
    return snapshot;
  }
  return snapshot.error.code === "not_found" ? ok(undefined) : snapshot;
};

/** Appends by read, concatenate, write over what was read. A lost race is read again. */
const appendTo = async (
  ops: LibraryOps,
  target: Target,
  added: Uint8Array,
  attempt: number
): Promise<Result<void, FileError>> => {
  const current = await readIfPresent(ops, target);
  if (!current.ok) {
    return current;
  }
  const bytes = concatBytes(current.value?.bytes ?? new Uint8Array(), added);
  const written = await callLibrary("open", target.absolute, () =>
    ops.write(target.library, bytes, ifUnchanged(current.value?.entry))
  );
  if (written.ok) {
    return ok(undefined);
  }
  if (attempt < APPEND_ATTEMPTS && isEagain(written.error)) {
    return appendTo(ops, target, added, attempt + 1);
  }
  return written;
};

const createFolder = async (
  ops: LibraryOps,
  target: Target,
  recursive: boolean
): Promise<Result<void, FileError>> => {
  if (!recursive) {
    const existing = await statEntry(ops, target);
    if (existing.ok) {
      return err(
        new FileError(
          "invalid",
          `EEXIST: file already exists, mkdir '${target.absolute}'`,
          target.absolute
        )
      );
    }
    if (existing.error.code !== "not_found") {
      return existing;
    }
    const parent = await statEntry(ops, parentTarget(target));
    if (!parent.ok) {
      return parent;
    }
    if (parent.value.kind === "file") {
      return err(
        new FileError(
          "not_directory",
          `ENOTDIR: not a directory, mkdir '${target.absolute}'`,
          target.absolute
        )
      );
    }
  }
  // The root always exists, so making it is a no-op, as `mkdir -p` is.
  if (target.library === "") {
    return ok(undefined);
  }
  const made = await callLibrary("mkdir", target.absolute, () =>
    ops.mkdir(target.library)
  );
  return made.ok ? ok(undefined) : made;
};

/** A reader's failure before it does anything: aborted first, then closed. */
const readerError = (
  context: Context,
  path: string,
  label: string,
  closed: boolean
): FileError | undefined => {
  const aborted = abortedError(context, path);
  if (aborted) {
    return aborted;
  }
  return closed
    ? new FileError("invalid", `${label} is closed`, path)
    : undefined;
};

/** Runs a reader call. A call that needs no I/O answers at once, so it is not async. */
const readerCall = <T>(
  context: Context,
  path: string,
  label: string,
  closed: boolean,
  task: () => Result<T, FileError>
): Promise<Result<T, FileError>> => {
  const failed = readerError(context, path, label, closed);
  return Promise.resolve(failed ? err<T, FileError>(failed) : task());
};

export const isCount = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

/** The bytes at a range of a snapshot. A range past its end is empty. */
const rangeOf = (
  bytes: Uint8Array,
  offset: number,
  length: number,
  path: string
): Result<Uint8Array, FileError> =>
  isCount(offset) && isCount(length)
    ? ok(bytes.slice(offset, offset + length))
    : err(
        new FileError(
          "invalid",
          "Offset and length must be non-negative safe integers",
          path
        )
      );

const scanOf = (
  bytes: Uint8Array,
  options: { startLine: number; endLine?: number },
  path: string
): Result<LineScan, FileError> => {
  let scanner: LineScanner;
  try {
    scanner = new LineScanner(options.startLine, options.endLine);
  } catch {
    return err(new FileError("invalid", "Invalid line range", path));
  }
  scanner.push(bytes);
  return ok(scanner.finish());
};

export const createBinaryReader = (
  path: string,
  info: FileInfo,
  bytes: Uint8Array
): BinaryReader => {
  const label = "Binary reader";
  let closed = false;
  return {
    close: () => {
      closed = true;
      return Promise.resolve();
    },
    info: (context) => readerCall(context, path, label, closed, () => ok(info)),
    read: (offset, length, context) =>
      readerCall(context, path, label, closed, () =>
        rangeOf(bytes, offset, length, path)
      ),
    scanLines: (options, context) =>
      readerCall(context, path, label, closed, () =>
        scanOf(bytes, options, path)
      ),
  };
};

/** Lines of text, split the way `NodeTextLineReader` splits them: the last one may lack its newline. */
export const createTextLineReader = (
  path: string,
  text: string
): TextLineReader => {
  let offset = 0;
  let closed = false;
  const nextLine = (): Result<TextLine | undefined, FileError> => {
    if (offset >= text.length) {
      return ok(undefined);
    }
    const newline = text.indexOf("\n", offset);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(offset, end);
    offset = newline === -1 ? text.length : newline + 1;
    return ok({ terminated: newline !== -1, text: line });
  };
  return {
    close: () => {
      closed = true;
      return Promise.resolve();
    },
    readLine: (context) =>
      readerCall(context, path, "Text line reader", closed, nextLine),
  };
};

/** Decodes like `NodeTextLineReader`, which decodes through the same streaming decoder. */
export const decodeStream = (bytes: Uint8Array): string => {
  const decoder = new StreamDecoder();
  return decoder.decode(bytes) + decoder.decode();
};

const openTextLines = (
  ops: LibraryOps,
  cwd: string,
  path: string,
  context: Context
): Promise<Result<TextLineReader, FileError>> =>
  withTarget(cwd, path, context, async (target) => {
    const snapshot = await readSnapshot(ops, target);
    if (!snapshot.ok) {
      return snapshot;
    }
    return ok(
      createTextLineReader(target.absolute, decodeStream(snapshot.value.bytes))
    );
  });

export const readLines = async (
  reader: TextLineReader,
  maxLines: number | undefined,
  context: Context
): Promise<Result<string[], FileError>> => {
  const lines: string[] = [];
  while (maxLines === undefined || lines.length < maxLines) {
    // biome-ignore lint/performance/noAwaitInLoops: each line reads the next one from the same reader
    const line = await reader.readLine(context);
    if (!line.ok) {
      return line;
    }
    if (line.value === undefined) {
      break;
    }
    lines.push(line.value.text);
  }
  return ok(lines);
};

/** A snapshot of a folder's entries, paged out by `next`. Entries are listed once, at open. */
export const createDirReader = (
  path: string,
  entries: FileInfo[]
): DirReader => {
  let position = 0;
  let closed = false;
  const page = (
    maxEntries: number
  ): Result<{ done: boolean; entries: FileInfo[] }, FileError> => {
    if (!(Number.isSafeInteger(maxEntries) && maxEntries > 0)) {
      return err(
        new FileError(
          "invalid",
          "maxEntries must be a positive safe integer",
          path
        )
      );
    }
    const slice = entries.slice(position, position + maxEntries);
    position += slice.length;
    return ok({ done: position >= entries.length, entries: slice });
  };
  return {
    close: () => {
      closed = true;
      return Promise.resolve();
    },
    next: (maxEntries, context) =>
      readerCall(context, path, "Directory reader", closed, () =>
        page(maxEntries)
      ),
  };
};

/** Refuses an operation the library has no way to do, after the abort check every method starts with. */
export const refuse = <T>(
  context: Context,
  path: string,
  message: string
): Result<T, FileError> =>
  err(
    abortedError(context, path) ?? new FileError("not_supported", message, path)
  );

/**
 * `workspaceId` names the file namespace: Pi serialises writes by environment
 * id and path, so two workspaces must not share an id.
 */
export const createLibraryEnv = ({
  ops,
  workspaceId,
  cwd = LIBRARY_MOUNT,
}: {
  ops: LibraryOps;
  workspaceId: string;
  cwd?: string;
}): ExecutionEnv => {
  const env: ExecutionEnv = {
    absolutePath: (path, context) => {
      const aborted = abortedError(context, path);
      return Promise.resolve(
        aborted
          ? err<string, FileError>(aborted)
          : ok(absoluteOf(env.cwd, path))
      );
    },

    appendFile: (path, content, context) =>
      withTarget(env.cwd, path, context, (target) =>
        appendTo(
          ops,
          target,
          typeof content === "string" ? ENCODER.encode(content) : content,
          1
        )
      ),

    canonicalPath: (path, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        const entry = await statEntry(ops, target);
        return entry.ok ? ok(target.absolute) : entry;
      }),

    cleanup: async () => undefined,

    createDir: (path, options, context) =>
      withTarget(env.cwd, path, context, (target) =>
        createFolder(ops, target, options?.recursive ?? true)
      ),

    createTempDir: (_prefix, context) =>
      Promise.resolve(
        refuse<string>(
          context,
          env.cwd,
          "Temporary directories are not available in the library"
        )
      ),

    createTempFile: (_options, context) =>
      Promise.resolve(
        refuse<string>(
          context,
          env.cwd,
          "Temporary files are not available in the library"
        )
      ),
    cwd,

    exec: async (_command, _options, context) =>
      context.abortSignal?.aborted
        ? err<ShellExecResult, ExecutionError>(
            new ExecutionError("aborted", "aborted")
          )
        : err<ShellExecResult, ExecutionError>(
            new ExecutionError(
              "shell_unavailable",
              "This environment has no shell. Use the library bash tool."
            )
          ),

    exists: async (path, context) => {
      const aborted = abortedError(context, path);
      if (aborted) {
        return err(aborted);
      }
      const target = targetOf(absoluteOf(env.cwd, path));
      if (target === null) {
        return ok(false);
      }
      const entry = await statEntry(ops, target);
      if (entry.ok) {
        return ok(true);
      }
      return entry.error.code === "not_found" ? ok(false) : err(entry.error);
    },

    fileInfo: (path, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        const entry = await statEntry(ops, target);
        return entry.ok ? ok(toFileInfo(target.absolute, entry.value)) : entry;
      }),

    flushFile: (path, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        const entry = await statEntry(ops, target);
        if (!entry.ok) {
          return entry;
        }
        return entry.value.kind === "dir"
          ? err(
              new FileError(
                "is_directory",
                `EISDIR: illegal operation on a directory, fsync '${target.absolute}'`,
                target.absolute
              )
            )
          : ok(undefined);
      }),
    id: `${ENV_ID_PREFIX}${workspaceId}`,

    joinPath: (parts, context) => {
      const joined = parts.join("/");
      const aborted = abortedError(context, joined);
      return Promise.resolve(
        aborted
          ? err<string, FileError>(aborted)
          : ok(absoluteOf(env.cwd, joined))
      );
    },

    listDir: (path, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        const entries = await listEntries(ops, target);
        return entries.ok
          ? ok(childInfos(target.absolute, entries.value))
          : entries;
      }),

    openBinaryReader: (path, _options, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        const snapshot = await readSnapshot(ops, target);
        if (!snapshot.ok) {
          return snapshot;
        }
        return ok(
          createBinaryReader(
            target.absolute,
            toFileInfo(target.absolute, snapshot.value.entry),
            snapshot.value.bytes
          )
        );
      }),

    openDirReader: (path, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        const entries = await listEntries(ops, target);
        return entries.ok
          ? ok(
              createDirReader(
                target.absolute,
                childInfos(target.absolute, entries.value)
              )
            )
          : entries;
      }),

    openTextLineReader: (path, context) =>
      openTextLines(ops, env.cwd, path, context),

    readBinaryFile: (path, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        const snapshot = await readSnapshot(ops, target);
        return snapshot.ok ? ok(snapshot.value.bytes) : snapshot;
      }),

    readTextFile: (path, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        const snapshot = await readSnapshot(ops, target);
        return snapshot.ok ? ok(UTF8.decode(snapshot.value.bytes)) : snapshot;
      }),

    readTextLines: async (path, options, context) => {
      if (options?.maxLines !== undefined && options.maxLines <= 0) {
        return ok([]);
      }
      const opened = await openTextLines(ops, env.cwd, path, context);
      if (!opened.ok) {
        return opened;
      }
      try {
        return await readLines(opened.value, options?.maxLines, context);
      } finally {
        await opened.value.close(context);
      }
    },

    remove: (path, options, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        const removed = await callLibrary("rm", target.absolute, () =>
          ops.remove(target.library, { recursive: options?.recursive === true })
        );
        if (
          !removed.ok &&
          options?.force === true &&
          removed.error.code === "not_found"
        ) {
          return ok(undefined);
        }
        return removed;
      }),

    renameFile: (sourcePath, destinationPath, context) =>
      withTarget(env.cwd, sourcePath, context, async (source) => {
        const destination = absoluteOf(env.cwd, destinationPath);
        const target = targetOf(destination);
        if (target === null) {
          return err(outsideLibrary(destination));
        }
        const moved = await callLibrary("rename", source.absolute, () =>
          ops.move(source.library, target.library)
        );
        return moved.ok ? ok(undefined) : moved;
      }),

    truncateFile: (path, size, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        if (!isCount(size)) {
          return err(
            new FileError(
              "invalid",
              "File size must be a non-negative safe integer",
              target.absolute
            )
          );
        }
        if (size > LIBRARY_FILE_MAX_BYTES) {
          return err(
            new FileError(
              "invalid",
              "Library files are limited to 10 MB",
              target.absolute
            )
          );
        }
        const snapshot = await readSnapshot(ops, target);
        if (!snapshot.ok) {
          return snapshot;
        }
        const resized = new Uint8Array(size);
        resized.set(snapshot.value.bytes.subarray(0, size));
        const written = await callLibrary("open", target.absolute, () =>
          ops.write(target.library, resized, ifUnchanged(snapshot.value.entry))
        );
        return written.ok ? ok(undefined) : written;
      }),

    watch: (_targets, _onChange, context) =>
      Promise.resolve(
        refuse<FileWatcher>(
          context,
          env.cwd,
          "Watching is not available in the library"
        )
      ),

    writeFile: (path, content, context) =>
      withTarget(env.cwd, path, context, async (target) => {
        const bytes =
          typeof content === "string" ? ENCODER.encode(content) : content;
        const written = await callLibrary("open", target.absolute, () =>
          ops.write(target.library, bytes)
        );
        return written.ok ? ok(undefined) : written;
      }),
  };
  return env;
};
