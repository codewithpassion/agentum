/**
 * An `ExecutionEnv` over the Linux VM of one agent, so Pi's `read`, `write`,
 * `edit` and `bash` tools work in the VM. Every absolute path is allowed, and a
 * relative path resolves against `cwd`, the agent's home folder by default.
 * Files go through `LinuxVm`; the readers and line helpers are the ones
 * `library-env.ts` uses. When `secrets` is given, each command gets the granted
 * env and its output is masked before the model sees it.
 */
import type { Context } from "@earendil-works/chord";
import {
  type ExecutionEnv,
  ExecutionError,
  err,
  FileError,
  type FileErrorCode,
  type FileInfo,
  type FileWatcher,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  toError,
} from "@earendil-works/pi-durable/env";
import { clamp } from "../library-bash/library-fs.ts";
import {
  abortedError,
  concatBytes,
  createBinaryReader,
  createDirReader,
  createTextLineReader,
  decodeStream,
  isCount,
  readLines,
  refuse,
} from "../library-env/library-env.ts";
import type { ScriptSecrets } from "../skill-scripts/run-skill-script.ts";
import {
  type LinuxVm,
  VM_HOME_DIR,
  type VmEntry,
  type VmExecResult,
  VmFileError,
  type VmStat,
} from "./vm-port.ts";

export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
export const MAX_EXEC_TIMEOUT_MS = 600_000;
export const EXEC_OUTPUT_BYTES = 1_048_576;

const ENV_ID_PREFIX = "harbourmaster:vm:";
const TMP_DIR = "/tmp";
const ENCODER = new TextEncoder();
const UTF8 = new TextDecoder("utf-8", { ignoreBOM: true });

const VM_ERROR_CODES = new Map<string, FileErrorCode>([
  ["ENOENT", "not_found"],
  ["EACCES", "permission_denied"],
  ["ENOTDIR", "not_directory"],
  ["EISDIR", "is_directory"],
  ["ENOSYS", "not_supported"],
]);

const lastSegment = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);

const absoluteOf = (cwd: string, path: string): string =>
  clamp(path.startsWith("/") ? path : `${cwd}/${path}`);

const fileErrorOf = (error: unknown, path: string): FileError => {
  if (error instanceof VmFileError) {
    return new FileError(
      VM_ERROR_CODES.get(error.code) ?? "invalid",
      error.message,
      path,
      error
    );
  }
  const cause = toError(error);
  return new FileError("unknown", cause.message, path, cause);
};

/** Runs one VM call and maps its failure to a FileError. */
const callVm = async <T>(
  path: string,
  task: () => Promise<T>
): Promise<Result<T, FileError>> => {
  try {
    return ok(await task());
  } catch (error) {
    return err(fileErrorOf(error, path));
  }
};

const toFileInfo = (path: string, stat: VmStat): FileInfo => ({
  kind: stat.kind,
  mtimeMs: stat.mtimeMs,
  name: lastSegment(path),
  path,
  size: stat.size,
});

/** Runs `task` for the absolute form of `path`, after the abort check every method starts with. */
const withPath = <T>(
  cwd: string,
  path: string,
  context: Context,
  task: (absolute: string) => Promise<Result<T, FileError>>
): Promise<Result<T, FileError>> => {
  const absolute = absoluteOf(cwd, path);
  const aborted = abortedError(context, absolute);
  return aborted ? Promise.resolve(err<T, FileError>(aborted)) : task(absolute);
};

const statOf = (
  vm: LinuxVm,
  path: string
): Promise<Result<VmStat, FileError>> => callVm(path, () => vm.stat(path));

const readBytes = (
  vm: LinuxVm,
  path: string
): Promise<Result<Uint8Array, FileError>> =>
  callVm(path, () => vm.readFile(path));

/** Writes a file, making its parent folders first, as the write tool promises. */
const writeWithParents = async (
  vm: LinuxVm,
  path: string,
  bytes: Uint8Array
): Promise<Result<void, FileError>> => {
  const parent = path.slice(0, path.lastIndexOf("/")) || "/";
  const made = await callVm(parent, () =>
    vm.mkdir(parent, { recursive: true })
  );
  return made.ok ? callVm(path, () => vm.writeFile(path, bytes)) : made;
};

/** The bytes of a file, or nothing when it is missing. */
const readIfPresent = async (
  vm: LinuxVm,
  path: string
): Promise<Result<Uint8Array | undefined, FileError>> => {
  const read = await readBytes(vm, path);
  if (read.ok) {
    return read;
  }
  return read.error.code === "not_found" ? ok(undefined) : read;
};

const childInfo = async (
  vm: LinuxVm,
  dir: string,
  entry: VmEntry
): Promise<Result<FileInfo | undefined, FileError>> => {
  const path = clamp(`${dir}/${entry.name}`);
  const stat = await statOf(vm, path);
  if (stat.ok) {
    return ok(toFileInfo(path, stat.value));
  }
  // An entry removed after the listing is skipped, as a directory reader skips it.
  return stat.error.code === "not_found" ? ok(undefined) : stat;
};

const listDirOf = async (
  vm: LinuxVm,
  path: string
): Promise<Result<FileInfo[], FileError>> => {
  const listed = await callVm(path, () => vm.list(path));
  if (!listed.ok) {
    return listed;
  }
  const results = await Promise.all(
    listed.value.map((entry) => childInfo(vm, path, entry))
  );
  const infos: FileInfo[] = [];
  for (const result of results) {
    if (!result.ok) {
      return result;
    }
    if (result.value !== undefined) {
      infos.push(result.value);
    }
  }
  return ok(infos);
};

const quoteArg = (arg: string): string => `'${arg.replaceAll("'", "'\\''")}'`;

const commandLine = (command: string | readonly string[]): string =>
  typeof command === "string" ? command : command.map(quoteArg).join(" ");

const timeoutMsOf = (seconds: number | undefined): number =>
  Math.min(
    seconds === undefined ? DEFAULT_EXEC_TIMEOUT_MS : seconds * 1000,
    MAX_EXEC_TIMEOUT_MS
  );

/** Hands a non-empty part of the output to the caller, stdout first. */
const deliver = (
  text: string,
  stream: "stdout" | "stderr",
  options: ShellExecOptions | undefined,
  context: Context
): void => {
  if (text !== "") {
    options?.onOutput?.(text, context, { stream });
  }
};

export const createVmEnv = ({
  vm,
  agentId,
  cwd = VM_HOME_DIR,
  secrets,
}: {
  vm: LinuxVm;
  agentId: string;
  cwd?: string;
  secrets?: ScriptSecrets;
}): ExecutionEnv => {
  /** Makes `/tmp` if it is missing, then runs `task`. */
  const withTmp = async <T>(
    context: Context,
    task: () => Promise<Result<T, FileError>>
  ): Promise<Result<T, FileError>> => {
    const aborted = abortedError(context, TMP_DIR);
    if (aborted) {
      return err(aborted);
    }
    const ready = await callVm(TMP_DIR, () =>
      vm.mkdir(TMP_DIR, { recursive: true })
    );
    return ready.ok ? task() : ready;
  };

  const tempPath = (prefix: string, suffix: string): string =>
    `${TMP_DIR}/${prefix}${crypto.randomUUID()}${suffix}`;

  const env: ExecutionEnv = {
    absolutePath: (path, context) =>
      withPath(env.cwd, path, context, (absolute) =>
        Promise.resolve(ok(absolute))
      ),

    appendFile: (path, content, context) =>
      withPath(env.cwd, path, context, async (absolute) => {
        const current = await readIfPresent(vm, absolute);
        if (!current.ok) {
          return current;
        }
        const added =
          typeof content === "string" ? ENCODER.encode(content) : content;
        return writeWithParents(
          vm,
          absolute,
          concatBytes(current.value ?? new Uint8Array(), added)
        );
      }),

    canonicalPath: (path, context) =>
      withPath(env.cwd, path, context, async (absolute) => {
        const stat = await statOf(vm, absolute);
        return stat.ok ? ok(absolute) : stat;
      }),

    cleanup: async () => undefined,

    createDir: (path, options, context) =>
      withPath(env.cwd, path, context, (absolute) =>
        callVm(absolute, () =>
          vm.mkdir(absolute, { recursive: options?.recursive ?? true })
        )
      ),

    createTempDir: (prefix, context) =>
      withTmp(context, async () => {
        const path = tempPath(prefix ?? "", "");
        const made = await callVm(path, () => vm.mkdir(path));
        return made.ok ? ok(path) : made;
      }),

    createTempFile: (options, context) =>
      withTmp(context, async () => {
        const path = tempPath(options?.prefix ?? "", options?.suffix ?? "");
        const written = await callVm(path, () =>
          vm.writeFile(path, new Uint8Array())
        );
        return written.ok ? ok(path) : written;
      }),

    cwd,

    exec: async (command, options, context) => {
      if (context.abortSignal?.aborted) {
        return err<ShellExecResult, ExecutionError>(
          new ExecutionError("aborted", "aborted")
        );
      }
      const timeoutMs = timeoutMsOf(options?.timeout);
      let result: VmExecResult;
      let granted: Awaited<ReturnType<ScriptSecrets["forRun"]>> | undefined;
      try {
        granted = await secrets?.forRun();
        result = await vm.exec({
          command: commandLine(command),
          cwd: options?.cwd ?? env.cwd,
          env: granted ? { ...options?.env, ...granted.env } : options?.env,
          maxOutputBytes: EXEC_OUTPUT_BYTES,
          timeoutMs,
        });
      } catch (error) {
        return err<ShellExecResult, ExecutionError>(
          new ExecutionError("spawn_error", toError(error).message)
        );
      }
      const mask =
        granted === undefined ? (text: string) => text : granted.mask;
      deliver(mask(result.stdout), "stdout", options, context);
      deliver(mask(result.stderr), "stderr", options, context);
      if (result.timedOut) {
        return err<ShellExecResult, ExecutionError>(
          new ExecutionError(
            "timeout",
            `Command timed out after ${timeoutMs / 1000} seconds`
          )
        );
      }
      return ok<ShellExecResult, ExecutionError>({
        exitCode: result.exitCode,
      });
    },

    exists: (path, context) =>
      withPath(env.cwd, path, context, async (absolute) => {
        const stat = await statOf(vm, absolute);
        if (stat.ok) {
          return ok(true);
        }
        return stat.error.code === "not_found" ? ok(false) : err(stat.error);
      }),

    fileInfo: (path, context) =>
      withPath(env.cwd, path, context, async (absolute) => {
        const stat = await statOf(vm, absolute);
        return stat.ok ? ok(toFileInfo(absolute, stat.value)) : stat;
      }),

    flushFile: (path, context) =>
      withPath(env.cwd, path, context, async (absolute) => {
        const stat = await statOf(vm, absolute);
        if (!stat.ok) {
          return stat;
        }
        return stat.value.kind === "directory"
          ? err(
              new FileError(
                "is_directory",
                `EISDIR: illegal operation on a directory, fsync '${absolute}'`,
                absolute
              )
            )
          : ok(undefined);
      }),

    id: `${ENV_ID_PREFIX}${agentId}`,

    joinPath: (parts, context) =>
      withPath(env.cwd, parts.join("/"), context, (absolute) =>
        Promise.resolve(ok(absolute))
      ),

    listDir: (path, context) =>
      withPath(env.cwd, path, context, (absolute) => listDirOf(vm, absolute)),

    openBinaryReader: (path, _options, context) =>
      withPath(env.cwd, path, context, async (absolute) => {
        const stat = await statOf(vm, absolute);
        if (!stat.ok) {
          return stat;
        }
        if (stat.value.kind === "directory") {
          return err(
            new FileError(
              "is_directory",
              `EISDIR: illegal operation on a directory, open '${absolute}'`,
              absolute
            )
          );
        }
        const bytes = await readBytes(vm, absolute);
        return bytes.ok
          ? ok(
              createBinaryReader(
                absolute,
                toFileInfo(absolute, stat.value),
                bytes.value
              )
            )
          : bytes;
      }),

    openDirReader: (path, context) =>
      withPath(env.cwd, path, context, async (absolute) => {
        const infos = await listDirOf(vm, absolute);
        return infos.ok ? ok(createDirReader(absolute, infos.value)) : infos;
      }),

    openTextLineReader: (path, context) =>
      withPath(env.cwd, path, context, async (absolute) => {
        const bytes = await readBytes(vm, absolute);
        return bytes.ok
          ? ok(createTextLineReader(absolute, decodeStream(bytes.value)))
          : bytes;
      }),

    readBinaryFile: (path, context) =>
      withPath(env.cwd, path, context, (absolute) => readBytes(vm, absolute)),

    readTextFile: (path, context) =>
      withPath(env.cwd, path, context, async (absolute) => {
        const bytes = await readBytes(vm, absolute);
        return bytes.ok ? ok(UTF8.decode(bytes.value)) : bytes;
      }),

    readTextLines: async (path, options, context) => {
      if (options?.maxLines !== undefined && options.maxLines <= 0) {
        return ok([]);
      }
      const opened = await env.openTextLineReader(path, context);
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
      withPath(env.cwd, path, context, (absolute) =>
        callVm(absolute, () =>
          vm.remove(absolute, {
            force: options?.force === true,
            recursive: options?.recursive === true,
          })
        )
      ),

    renameFile: (sourcePath, destinationPath, context) =>
      withPath(env.cwd, sourcePath, context, (source) =>
        callVm(source, () =>
          vm.rename(source, absoluteOf(env.cwd, destinationPath))
        )
      ),

    truncateFile: (path, size, context) =>
      withPath(env.cwd, path, context, async (absolute) => {
        if (!isCount(size)) {
          return err(
            new FileError(
              "invalid",
              "File size must be a non-negative safe integer",
              absolute
            )
          );
        }
        const bytes = await readBytes(vm, absolute);
        if (!bytes.ok) {
          return bytes;
        }
        const resized = new Uint8Array(size);
        resized.set(bytes.value.subarray(0, size));
        return callVm(absolute, () => vm.writeFile(absolute, resized));
      }),

    watch: (_targets, _onChange, context) =>
      Promise.resolve(
        refuse<FileWatcher>(
          context,
          env.cwd,
          "Watching is not available in the VM"
        )
      ),

    writeFile: (path, content, context) =>
      withPath(env.cwd, path, context, (absolute) =>
        writeWithParents(
          vm,
          absolute,
          typeof content === "string" ? ENCODER.encode(content) : content
        )
      ),
  };
  return env;
};
