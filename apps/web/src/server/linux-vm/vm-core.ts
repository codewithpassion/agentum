// The logic of one session's Linux VM, kept free of `cloudflare:workers` and of
// the Sandbox SDK so bun can test it with a fake container. `vm-session.ts`
// wraps it in the Durable Object.
//
// The container starts on the first call and gets the session's /workspace back
// from its last snapshot. Every call counts as activity. An alarm looks every
// CHECK_MS: once the VM has been idle for `idleMs` it snapshots /workspace to
// R2 and destroys the container, and the next call starts it again. A command
// runs with no environment of ours and under a wall-time cap, and its output is
// read up to a cap.
import {
  type LinuxVm,
  VM_WORKDIR,
  type VmEntry,
  type VmErrorCode,
  VmFileError,
  type VmFileKind,
  type VmStat,
} from "./vm-port.ts";

/** How often the alarm looks at an awake VM. */
export const CHECK_MS = 30_000;
/** A VM that is not ready this long after `start` has failed to start. */
export const READY_TIMEOUT_MS = 60_000;
const READY_POLL_MS = 250;
/** One readiness probe that has not answered after this long counts as failed. */
const PROBE_TIMEOUT_MS = 5000;
/** Snapshots that fail this many times in a row are given up on, so a broken bucket cannot keep a VM running. */
export const MAX_SNAPSHOT_FAILURES = 3;
/** After the wall time, the command's process gets this long to end by itself before it is aborted. */
const ABORT_GRACE_MS = 3000;
/** The exit code of `timeout(1)` when the command ran out of time. */
const TIMEOUT_EXIT_CODE = 124;
const SNAPSHOT_KEY = "snapshot";
/** Set once the container has started and its workdir is ready, and cleared when it is destroyed. A Durable Object that restarts while the container runs reads it to tell a finished start from a cut-off one. */
const PREPARED_KEY = "prepared";
/** The exit code of a command that `timeout -k` had to kill: the signal number 9 plus 128. */
const KILLED_EXIT_CODE = 137;
/** `timeout` waits this many seconds after TERM before it kills the command. */
const KILL_AFTER_SECONDS = 2;
/** Commands see a home folder, so tools that keep a cache there (bun, npm, git) work. */
const VM_HOME = "/root";

export interface VmProcess {
  exitCode: Promise<number>;
  stderr: ReadableStream<Uint8Array> | null;
  stdout: ReadableStream<Uint8Array> | null;
}

/** The part of `ctx.container` the core uses. The Durable Object adds the image and size to `start`. */
export interface VmContainer {
  destroy: (reason: string) => Promise<void>;
  exec: (
    command: string[],
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      signal?: AbortSignal;
    }
  ) => Promise<VmProcess>;
  readonly running: boolean;
  /** How long the platform keeps the container up once the Durable Object is idle. */
  setInactivityTimeout: (ms: number) => Promise<void>;
  start: () => void;
}

/** The part of the Sandbox SDK's `Files` the core uses. */
export interface VmFiles {
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  readDirectory: (path: string) => Promise<{ name: string; type: string }[]>;
  readFile: (path: string) => Promise<Response>;
  remove: (
    path: string,
    options?: { force?: boolean; recursive?: boolean }
  ) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  stat: (
    path: string
  ) => Promise<{ modifiedAt: Date; size: bigint; type: string }>;
  writeFile: (path: string, content: Uint8Array) => Promise<void>;
}

/** What `DirectoryBackup` returns for one saved directory. */
export interface VmSnapshot {
  readonly dir: string;
  readonly id: string;
}

/** The part of the Sandbox SDK's `DirectoryBackup` the core uses. */
export interface VmBackups<TSnapshot extends VmSnapshot = VmSnapshot> {
  backup: (options: { dir: string; name?: string }) => Promise<TSnapshot>;
  delete: (snapshot: TSnapshot) => Promise<void>;
  restore: (snapshot: TSnapshot) => Promise<void>;
}

export interface VmStorage {
  delete: (key: string) => Promise<unknown>;
  get: <T>(key: string) => Promise<T | undefined>;
  put: <T>(key: string, value: T) => Promise<void>;
}

export interface VmCoreDeps<TSnapshot extends VmSnapshot = VmSnapshot> {
  backups: VmBackups<TSnapshot>;
  container: VmContainer;
  deleteAlarm: () => Promise<void>;
  files: VmFiles;
  /** How long the VM sits idle before it snapshots and sleeps. */
  idleMs: number;
  /** A label for the snapshot, so a bucket listing says whose it is. */
  label: string;
  now?: () => number;
  /** How long one readiness probe may take. */
  probeTimeoutMs?: number;
  setAlarm: (at: number) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  storage: VmStorage;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const FILE_ERROR_CODES = new Set<VmErrorCode>([
  "EACCES",
  "EEXIST",
  "EINVAL",
  "EISDIR",
  "ENOENT",
  "ENOTDIR",
  "ENOTEMPTY",
]);

const asErrorCode = (code: string): VmErrorCode =>
  FILE_ERROR_CODES.has(code as VmErrorCode) ? (code as VmErrorCode) : "UNKNOWN";

/** The Sandbox SDK's `SandboxFileError`, recognised by name so this file imports nothing of it. */
const isSandboxFileError = (
  error: unknown
): error is Error & { code: string; path?: string } =>
  error instanceof Error &&
  error.name === "SandboxFileError" &&
  "code" in error &&
  typeof error.code === "string";

const toVmError = (error: unknown): unknown =>
  isSandboxFileError(error)
    ? new VmFileError(asErrorCode(error.code), error.message)
    : error;

const kindOf = (type: string): VmFileKind => {
  if (type === "directory" || type === "symlink") {
    return type;
  }
  return "file";
};

interface Capped {
  text: () => string;
  truncated: () => boolean;
}

/** Reads a stream to its end and keeps the first `max` bytes. Reading goes on after the cap, so the process never blocks on a full pipe. */
const readCapped = (
  stream: ReadableStream<Uint8Array> | null,
  max: number
): { capped: Capped; done: Promise<void> } => {
  const decoder = new TextDecoder();
  let kept = 0;
  let text = "";
  let truncated = false;
  const capped: Capped = { text: () => text, truncated: () => truncated };
  if (stream === null) {
    return { capped, done: Promise.resolve() };
  }
  const reader = stream.getReader();
  const done = (async () => {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: chunks arrive in order
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      const room = max - kept;
      if (room <= 0) {
        truncated = true;
        continue;
      }
      const part =
        chunk.value.byteLength <= room
          ? chunk.value
          : chunk.value.subarray(0, room);
      truncated ||= part.byteLength < chunk.value.byteLength;
      kept += part.byteLength;
      text += decoder.decode(part, { stream: true });
    }
    // A cut inside a character leaves its first bytes in the decoder, and flushing them would add a replacement character.
    if (!truncated) {
      text += decoder.decode();
    }
  })().catch(() => undefined);
  return { capped, done };
};

export const createVmCore = <TSnapshot extends VmSnapshot>({
  backups,
  container,
  deleteAlarm,
  files,
  idleMs,
  label,
  now = Date.now,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  setAlarm,
  sleep = defaultSleep,
  storage,
}: VmCoreDeps<TSnapshot>) => {
  let busy = 0;
  let lastActivity = now();
  let alarmSet = false;
  let snapshotFailures = 0;
  /** Starting and sleeping take turns: a call that arrives mid-sleep starts the VM again afterwards. */
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = <T>(task: () => Promise<T>): Promise<T> => {
    const next = turn.then(task);
    turn = next.catch(() => undefined);
    return next;
  };

  const inactivityMs = idleMs + CHECK_MS * 2;

  /** Runs `true` in the container. Gives up on a container that takes the whole `probeTimeoutMs` to answer. */
  const probe = async (): Promise<boolean> => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        // The abort also ends an `exec` that is still waiting for the container, so slow starts do not pile probes up.
        abort.abort();
        resolve(false);
      }, probeTimeoutMs);
    });
    try {
      return await Promise.race([
        container
          .exec(["true"], { signal: abort.signal })
          .then(async (process) => (await process.exitCode) === 0),
        expired,
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const waitReady = async (): Promise<void> => {
    const deadline = now() + READY_TIMEOUT_MS;
    let last = "no answer yet";
    while (now() < deadline) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: each probe waits for the one before
        if (await probe()) {
          return;
        }
        last = "the probe command failed or timed out";
      } catch (error) {
        last = describe(error);
      }
      await sleep(READY_POLL_MS);
    }
    throw new Error(`The Linux VM did not start: ${last}`);
  };

  /** Puts the last snapshot back, or makes an empty workdir. A snapshot that cannot be restored must not stop the session. */
  const prepareWorkdir = async (): Promise<void> => {
    const snapshot = await storage.get<TSnapshot>(SNAPSHOT_KEY);
    if (snapshot) {
      try {
        await backups.restore(snapshot);
        return;
      } catch (error) {
        console.error(
          `LinuxVm ${label}: restoring the snapshot failed, starting empty: ${describe(error)}`
        );
        await storage.delete(SNAPSHOT_KEY);
      }
    }
    await files.mkdir(VM_WORKDIR, { recursive: true });
  };

  const start = async (): Promise<void> => {
    if (container.running && (await storage.get<boolean>(PREPARED_KEY))) {
      return;
    }
    try {
      // A container that is running without the mark was cut off by a restart of this object, before its workdir was ready.
      if (!container.running) {
        container.start();
      }
      await container.setInactivityTimeout(inactivityMs);
      await waitReady();
      await prepareWorkdir();
      await storage.put(PREPARED_KEY, true);
    } catch (error) {
      // A container left running would pass for a started one on the next call, with no restore.
      await container.destroy("start failed").catch(() => undefined);
      throw error;
    }
  };

  /** Runs `task` as one call: the VM is up, and counts as busy until the call ends. */
  const active = async <T>(task: () => Promise<T>): Promise<T> => {
    busy += 1;
    try {
      await inTurn(start);
      if (!alarmSet) {
        alarmSet = true;
        await setAlarm(now() + CHECK_MS);
      }
      return await task();
    } catch (error) {
      throw toVmError(error);
    } finally {
      busy -= 1;
      lastActivity = now();
    }
  };

  const exec: LinuxVm["exec"] = (input) =>
    active(async () => {
      const wallSeconds = Math.max(1, Math.ceil(input.timeoutMs / 1000));
      const abort = new AbortController();
      const backstop = setTimeout(
        () => abort.abort(),
        input.timeoutMs + ABORT_GRACE_MS
      );
      try {
        const startedAt = now();
        // `timeout` ends the command's whole process group, which an abort of the shell alone would not. It sends TERM and, if that is ignored, KILL.
        const process = await container.exec(
          [
            "timeout",
            "-k",
            String(KILL_AFTER_SECONDS),
            String(wallSeconds),
            "bash",
            "-c",
            input.command,
          ],
          {
            cwd: input.cwd ?? VM_WORKDIR,
            env: { HOME: VM_HOME, ...input.env },
            signal: abort.signal,
          }
        );
        const out = readCapped(process.stdout, input.maxOutputBytes);
        const err = readCapped(process.stderr, input.maxOutputBytes);
        const aborted = new Promise<"aborted">((resolve) => {
          abort.signal.addEventListener("abort", () => resolve("aborted"));
        });
        const finished = Promise.all([process.exitCode, out.done, err.done])
          .then(([code]) => code)
          .catch((error: unknown) => {
            // An aborted process may reject its exit code, which is the timeout and not a failure.
            if (abort.signal.aborted) {
              return "aborted" as const;
            }
            throw error;
          });
        const outcome = await Promise.race([finished, aborted]);
        // After KILL, `timeout` ends with the command's group and exits 137 instead of 124.
        const timedOut =
          outcome === "aborted" ||
          outcome === TIMEOUT_EXIT_CODE ||
          (outcome === KILLED_EXIT_CODE &&
            now() - startedAt >= input.timeoutMs);
        return {
          exitCode: outcome === "aborted" ? TIMEOUT_EXIT_CODE : outcome,
          stderr: err.capped.text(),
          stdout: out.capped.text(),
          timedOut,
          truncated: out.capped.truncated() || err.capped.truncated(),
        };
      } finally {
        clearTimeout(backstop);
      }
    });

  const readFile: LinuxVm["readFile"] = (path) =>
    active(
      async () =>
        new Uint8Array(await (await files.readFile(path)).arrayBuffer())
    );

  const writeFile: LinuxVm["writeFile"] = (path, bytes) =>
    active(() => files.writeFile(path, bytes));

  const stat: LinuxVm["stat"] = (path) =>
    active(async (): Promise<VmStat> => {
      const info = await files.stat(path);
      return {
        kind: kindOf(info.type),
        mtimeMs: info.modifiedAt.getTime(),
        size: Number(info.size),
      };
    });

  const list: LinuxVm["list"] = (path) =>
    active(
      async (): Promise<VmEntry[]> =>
        (await files.readDirectory(path)).map((entry) => ({
          kind: kindOf(entry.type),
          name: entry.name,
        }))
    );

  const mkdir: LinuxVm["mkdir"] = (path, options) =>
    active(() => files.mkdir(path, options));

  const remove: LinuxVm["remove"] = (path, options) =>
    active(() => files.remove(path, options));

  const rename: LinuxVm["rename"] = (from, to) =>
    active(() => files.rename(from, to));

  /** Saves /workspace and replaces the snapshot before it. Returns false when the save failed and the VM should stay up. */
  const snapshot = async (): Promise<boolean> => {
    try {
      const saved = await backups.backup({ dir: VM_WORKDIR, name: label });
      const previous = await storage.get<TSnapshot>(SNAPSHOT_KEY);
      await storage.put(SNAPSHOT_KEY, saved);
      if (previous) {
        await backups.delete(previous).catch((error: unknown) => {
          console.warn(
            `LinuxVm ${label}: deleting the old snapshot failed: ${describe(error)}`
          );
        });
      }
      return true;
    } catch (error) {
      if (
        isSandboxFileError(error) &&
        error.code === "ENOENT" &&
        error.path === VM_WORKDIR
      ) {
        // No workdir, so nothing was ever put in the VM.
        return true;
      }
      snapshotFailures += 1;
      console.error(
        `LinuxVm ${label}: snapshot failed (${snapshotFailures} of ${MAX_SNAPSHOT_FAILURES}): ${describe(error)}`
      );
      return snapshotFailures >= MAX_SNAPSHOT_FAILURES;
    }
  };

  /** Snapshots /workspace and destroys the container. A VM with a call in flight is left alone. */
  const sleepNow = (): Promise<boolean> =>
    inTurn(async () => {
      if (!container.running) {
        return true;
      }
      if (busy > 0) {
        return false;
      }
      if (!(await snapshot())) {
        return false;
      }
      snapshotFailures = 0;
      await storage.delete(PREPARED_KEY);
      await container.destroy("idle");
      return true;
    });

  /** The Durable Object's alarm: puts an idle VM to sleep, or looks again later. */
  const alarm = async (): Promise<void> => {
    alarmSet = false;
    if (!container.running) {
      return;
    }
    // A restarted Durable Object loses the timeout it set.
    await container.setInactivityTimeout(inactivityMs);
    const idle = busy === 0 && now() - lastActivity >= idleMs;
    if (!(idle && (await sleepNow()))) {
      alarmSet = true;
      await setAlarm(now() + CHECK_MS);
      return;
    }
    await deleteAlarm();
  };

  /** Called when the Durable Object starts. A restarted object has lost the inactivity timeout of a container that is still running. */
  const wake = async (): Promise<void> => {
    if (container.running) {
      await container.setInactivityTimeout(inactivityMs);
    }
  };

  return {
    alarm,
    exec,
    list,
    mkdir,
    readFile,
    remove,
    rename,
    sleepNow,
    stat,
    wake,
    writeFile,
  };
};
