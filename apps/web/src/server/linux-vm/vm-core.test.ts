import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  CHECK_MS,
  createVmCore,
  MAX_SNAPSHOT_FAILURES,
  READY_TIMEOUT_MS,
  type VmBackups,
  type VmContainer,
  type VmFiles,
  type VmSnapshot,
  type VmStorage,
} from "./vm-core.ts";
import {
  VM_HOME_DIR,
  VM_WORKDIR,
  type VmExecInput,
  VmFileError,
} from "./vm-port.ts";

const IDLE_MS = 300_000;
const LABEL = "session-1";
const SNAPSHOT_KEY = "snapshot";
const PREPARED_KEY = "prepared";

type ExecOptions = NonNullable<Parameters<VmContainer["exec"]>[1]>;

/** What a fake command does: its exit, its output, or that it never ends. */
interface FakeRun {
  exit?: number;
  /** The exit comes when this promise resolves. */
  gate?: Promise<number>;
  /** The exit never comes unless the signal aborts, as with a command that runs forever. */
  hang?: boolean;
  /** The output streams never end, as when a background child keeps them open after the command has exited. */
  openStreams?: boolean;
  stderr?: Uint8Array[];
  stdout?: Uint8Array[];
}

interface ExecCall {
  command: string[];
  options: ExecOptions | undefined;
  /** Chunks of output the core did not read. Zero once the process was read to its end. */
  unread: () => number;
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const chunkStream = (
  chunks: Uint8Array[]
): { remaining: () => number; stream: ReadableStream<Uint8Array> } => {
  const queue = [...chunks];
  return {
    remaining: () => queue.length,
    stream: new ReadableStream<Uint8Array>({
      pull: (controller) => {
        const next = queue.shift();
        if (next === undefined) {
          controller.close();
        } else {
          controller.enqueue(next);
        }
      },
    }),
  };
};

const openStream = (
  chunks: Uint8Array[]
): { remaining: () => number; stream: ReadableStream<Uint8Array> } => ({
  remaining: () => 0,
  stream: new ReadableStream<Uint8Array>({
    start: (controller) => {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
    },
  }),
});

const createFakeContainer = () => {
  let running = false;
  const calls: ExecCall[] = [];
  const destroyed: string[] = [];
  const inactivity: number[] = [];
  let starts = 0;
  const container = {
    answer: (_command: string[]): FakeRun => ({ exit: 0 }),
    calls,
    destroy: (reason: string) => {
      running = false;
      destroyed.push(reason);
      return Promise.resolve();
    },
    destroyed,
    exec: (command: string[], options?: ExecOptions) =>
      Promise.resolve().then(() => {
        const run = container.answer(command);
        const make = run.openStreams ? openStream : chunkStream;
        const out = make(run.stdout ?? []);
        const err = make(run.stderr ?? []);
        const exitCode = run.hang
          ? new Promise<number>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => {
                reject(new Error("killed"));
              });
            })
          : (run.gate ?? Promise.resolve(run.exit ?? 0));
        calls.push({
          command,
          options,
          unread: () => out.remaining() + err.remaining(),
        });
        return {
          exitCode,
          stderr: err.stream,
          stdout: out.stream,
        };
      }),
    inactivity,
    get running() {
      return running;
    },
    setInactivityTimeout: (ms: number) => {
      inactivity.push(ms);
      return Promise.resolve();
    },
    /** A container that is already up, as after a restart of the Durable Object. */
    setRunning: (value: boolean) => {
      running = value;
    },
    start: () => {
      running = true;
      starts += 1;
    },
    get starts() {
      return starts;
    },
  };
  return container;
};

const createFakeFiles = () => {
  const contents = new Map<string, Uint8Array>();
  const entries = new Map<string, { size: bigint; type: string }>();
  const listing = new Map<string, { name: string; type: string }[]>();
  const mkdirs: {
    options: { recursive?: boolean } | undefined;
    path: string;
  }[] = [];
  const hooks: { fail: Error | null } = { fail: null };
  const failed = (): Promise<never> | null =>
    hooks.fail === null ? null : Promise.reject(hooks.fail);
  const files: VmFiles = {
    mkdir: (path, options) => {
      mkdirs.push({ options, path });
      return failed() ?? Promise.resolve();
    },
    readDirectory: (path) =>
      failed() ?? Promise.resolve(listing.get(path) ?? []),
    readFile: (path) => {
      const body = Uint8Array.from(contents.get(path) ?? []);
      return failed() ?? Promise.resolve(new Response(body));
    },
    remove: () => failed() ?? Promise.resolve(),
    rename: () => failed() ?? Promise.resolve(),
    stat: (path) => {
      const entry = entries.get(path);
      if (entry === undefined) {
        return Promise.reject(new Error(`no such path ${path}`));
      }
      return (
        failed() ?? Promise.resolve({ ...entry, modifiedAt: new Date(1234) })
      );
    },
    writeFile: (path, content) => {
      contents.set(path, content);
      return failed() ?? Promise.resolve();
    },
  };
  return { entries, files, hooks, listing, mkdirs };
};

const createFakeBackups = () => {
  let made = 0;
  const calls = {
    backup: [] as { dir: string; name?: string }[],
    delete: [] as VmSnapshot[],
    restore: [] as VmSnapshot[],
  };
  const hooks: {
    backupError: Error | null;
    deleteError: Error | null;
    restoreError: Error | null;
  } = { backupError: null, deleteError: null, restoreError: null };
  const backups: VmBackups = {
    backup: (options) => {
      calls.backup.push(options);
      if (hooks.backupError !== null) {
        return Promise.reject(hooks.backupError);
      }
      made += 1;
      return Promise.resolve({ dir: options.dir, id: `snap-${made}` });
    },
    delete: (snapshot) => {
      calls.delete.push(snapshot);
      return hooks.deleteError === null
        ? Promise.resolve()
        : Promise.reject(hooks.deleteError);
    },
    restore: (snapshot) => {
      calls.restore.push(snapshot);
      return hooks.restoreError === null
        ? Promise.resolve()
        : Promise.reject(hooks.restoreError);
    },
  };
  return { backups, calls, hooks };
};

const createFakeStorage = () => {
  const map = new Map<string, unknown>();
  const storage: VmStorage = {
    delete: (key) => Promise.resolve(map.delete(key)),
    get: <T>(key: string) => Promise.resolve(map.get(key) as T | undefined),
    put: <T>(key: string, value: T) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
  return { map, storage };
};

const setup = (probeTimeoutMs?: number) => {
  const clock = { now: 1_000_000 };
  const container = createFakeContainer();
  const files = createFakeFiles();
  const backups = createFakeBackups();
  const { map, storage } = createFakeStorage();
  const alarms = {
    current: null as number | null,
    deletes: 0,
    set: [] as number[],
  };
  const core = createVmCore({
    backups: backups.backups,
    container,
    deleteAlarm: () => {
      alarms.current = null;
      alarms.deletes += 1;
      return Promise.resolve();
    },
    files: files.files,
    idleMs: IDLE_MS,
    label: LABEL,
    now: () => clock.now,
    ...(probeTimeoutMs === undefined ? {} : { probeTimeoutMs }),
    setAlarm: (at) => {
      alarms.set.push(at);
      alarms.current = at;
      return Promise.resolve();
    },
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
    storage,
  });
  return { alarms, backups, clock, container, core, files, storage: map };
};

const input = (
  command: string,
  extra: Partial<VmExecInput> = {}
): VmExecInput => ({
  command,
  maxOutputBytes: 1_000_000,
  timeoutMs: 10_000,
  ...extra,
});

/** Lets every pending promise settle. The fakes use no timers, so one macrotask is enough. */
const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const probesOf = (container: ReturnType<typeof createFakeContainer>) =>
  container.calls.filter(
    (call) => call.command.length === 1 && call.command[0] === "true"
  );

const lastCall = (
  container: ReturnType<typeof createFakeContainer>
): ExecCall => {
  const call = container.calls.at(-1);
  if (call === undefined) {
    throw new Error("no exec call was made");
  }
  return call;
};

const fileError = (code: string, path: string = VM_HOME_DIR): Error =>
  Object.assign(new Error(`${code} from the VM`), {
    code,
    name: "SandboxFileError",
    path,
  });

const quietConsole = () => {
  spyOn(console, "error").mockImplementation(() => undefined);
  spyOn(console, "warn").mockImplementation(() => undefined);
};

afterEach(() => {
  mock.restore();
});

describe("createVmCore: starting", () => {
  test("with no snapshot, the first call starts the container once, sets the timeout, waits for the probe, makes /workspace and then the home folder, and arms the alarm", async () => {
    const env = setup();
    const start = env.clock.now;

    await Promise.all([env.core.list(VM_WORKDIR), env.core.list(VM_WORKDIR)]);

    expect(env.container.starts).toBe(1);
    expect(env.container.inactivity).toEqual([IDLE_MS + 60_000]);
    expect(probesOf(env.container)).toHaveLength(1);
    expect(env.files.mkdirs).toEqual([
      { options: { recursive: true }, path: VM_WORKDIR },
      { options: { recursive: true }, path: VM_HOME_DIR },
    ]);
    expect(env.alarms.set).toEqual([start + CHECK_MS]);
  });

  test("with a stored snapshot, the first call restores it into the home folder, makes /workspace and does not make the home folder", async () => {
    const env = setup();
    const snapshot = { dir: VM_HOME_DIR, id: "snap-old" };
    await env.storage.set(SNAPSHOT_KEY, snapshot);

    await env.core.list(VM_WORKDIR);

    expect(env.backups.calls.restore).toEqual([snapshot]);
    expect(env.files.mkdirs).toEqual([
      { options: { recursive: true }, path: VM_WORKDIR },
    ]);
  });

  test("a restore that throws drops the stored snapshot, makes /workspace and then the home folder, and the call still succeeds", async () => {
    quietConsole();
    const env = setup();
    env.storage.set(SNAPSHOT_KEY, { dir: VM_HOME_DIR, id: "snap-bad" });
    env.backups.hooks.restoreError = new Error("snapshot is corrupt");

    await expect(env.core.list(VM_WORKDIR)).resolves.toEqual([]);

    expect(env.storage.has(SNAPSHOT_KEY)).toBe(false);
    expect(env.files.mkdirs).toEqual([
      { options: { recursive: true }, path: VM_WORKDIR },
      { options: { recursive: true }, path: VM_HOME_DIR },
    ]);
  });

  test("a container that never answers the probe makes the call fail with 'did not start'", async () => {
    const env = setup();
    env.container.answer = () => ({ exit: 1 });

    await expect(env.core.list(VM_WORKDIR)).rejects.toThrow("did not start");
    expect(env.clock.now).toBeGreaterThanOrEqual(1_000_000 + READY_TIMEOUT_MS);
  });

  test("a probe that never ends makes the call fail instead of hanging", async () => {
    const env = setup(1);
    env.container.answer = () => ({ hang: true });

    await expect(env.core.list(VM_WORKDIR)).rejects.toThrow("did not start");
  });

  test("a call after a failed start waits for readiness and makes the workdir again", async () => {
    const env = setup();
    env.container.answer = () => ({ exit: 1 });
    await expect(env.core.list(VM_WORKDIR)).rejects.toThrow("did not start");

    env.container.answer = () => ({ exit: 0 });
    await env.core.list(VM_WORKDIR);

    expect(env.files.mkdirs).toEqual([
      { options: { recursive: true }, path: VM_WORKDIR },
      { options: { recursive: true }, path: VM_HOME_DIR },
    ]);
  });
});

describe("createVmCore: a restart of the Durable Object", () => {
  test("a container that is running without the prepared mark gets its readiness check, restore and workdir before the call runs", async () => {
    const env = setup();
    env.container.setRunning(true);
    env.storage.set(SNAPSHOT_KEY, { dir: VM_HOME_DIR, id: "snap-1" });

    await env.core.list(VM_WORKDIR);

    expect(env.container.starts).toBe(0);
    expect(probesOf(env.container)).toHaveLength(1);
    expect(env.backups.calls.restore).toEqual([
      { dir: VM_HOME_DIR, id: "snap-1" },
    ]);
    expect(env.storage.get(PREPARED_KEY)).toBe(true);
  });

  test("a container that is running with the prepared mark is used as it is", async () => {
    const env = setup();
    env.container.setRunning(true);
    env.storage.set(PREPARED_KEY, true);

    await env.core.list(VM_WORKDIR);

    expect(env.container.starts).toBe(0);
    expect(probesOf(env.container)).toHaveLength(0);
    expect(env.files.mkdirs).toEqual([]);
  });

  test("wake sets the inactivity timeout again for a running container and does nothing for a stopped one", async () => {
    const env = setup();
    await env.core.wake();
    expect(env.container.inactivity).toEqual([]);

    env.container.setRunning(true);
    await env.core.wake();
    expect(env.container.inactivity).toEqual([IDLE_MS + 60_000]);
  });

  test("sleeping clears the prepared mark, so the next start prepares the workdir again", async () => {
    const env = setup();
    await env.core.list(VM_WORKDIR);
    expect(env.storage.get(PREPARED_KEY)).toBe(true);

    env.clock.now += IDLE_MS;
    await env.core.alarm();

    expect(env.storage.has(PREPARED_KEY)).toBe(false);
  });
});

describe("createVmCore: the alarm and sleep", () => {
  test("an idle VM is snapshotted, the old snapshot is replaced, the container is destroyed and the alarm deleted; the next call restores the new one", async () => {
    const env = setup();
    await env.core.list(VM_WORKDIR);

    env.clock.now += IDLE_MS;
    await env.core.alarm();

    expect(env.backups.calls.backup).toEqual([
      { dir: VM_HOME_DIR, name: LABEL },
    ]);
    expect(env.storage.get(SNAPSHOT_KEY)).toEqual({
      dir: VM_HOME_DIR,
      id: "snap-1",
    });
    expect(env.backups.calls.delete).toEqual([]);
    expect(env.container.destroyed).toEqual(["idle"]);
    expect(env.alarms.current).toBeNull();
    expect(env.alarms.deletes).toBe(1);

    await env.core.list(VM_WORKDIR);
    expect(env.container.starts).toBe(2);
    expect(env.backups.calls.restore).toEqual([
      { dir: VM_HOME_DIR, id: "snap-1" },
    ]);

    env.clock.now += IDLE_MS;
    await env.core.alarm();

    expect(env.backups.calls.delete).toEqual([
      { dir: VM_HOME_DIR, id: "snap-1" },
    ]);
    expect(env.storage.get(SNAPSHOT_KEY)).toEqual({
      dir: VM_HOME_DIR,
      id: "snap-2",
    });
  });

  test("an alarm while a call is in flight leaves the VM up and sets the alarm again", async () => {
    const env = setup();
    let finish: (code: number) => void = () => undefined;
    const gate = new Promise<number>((resolve) => {
      finish = resolve;
    });
    env.container.answer = (command) =>
      command.at(-1) === "slow" ? { gate } : { exit: 0 };

    const busy = env.core.exec(input("slow"));
    await flush();
    env.clock.now += IDLE_MS;
    await env.core.alarm();

    expect(env.backups.calls.backup).toEqual([]);
    expect(env.container.destroyed).toEqual([]);
    expect(env.container.running).toBe(true);
    expect(env.alarms.current).toBe(env.clock.now + CHECK_MS);

    finish(0);
    await busy;
  });

  test("an alarm before idleMs has passed leaves the VM up and sets the alarm again", async () => {
    const env = setup();
    await env.core.list(VM_WORKDIR);

    env.clock.now += IDLE_MS - 1;
    await env.core.alarm();

    expect(env.backups.calls.backup).toEqual([]);
    expect(env.container.destroyed).toEqual([]);
    expect(env.container.running).toBe(true);
    expect(env.alarms.current).toBe(env.clock.now + CHECK_MS);
  });

  test("a snapshot that keeps failing keeps the VM up, and the VM is destroyed after MAX_SNAPSHOT_FAILURES", async () => {
    quietConsole();
    const env = setup();
    env.backups.hooks.backupError = new Error("bucket is down");
    await env.core.list(VM_WORKDIR);

    for (let attempt = 1; attempt < MAX_SNAPSHOT_FAILURES; attempt += 1) {
      env.clock.now += IDLE_MS;
      // biome-ignore lint/performance/noAwaitInLoops: each alarm follows the one before
      await env.core.alarm();
      expect(env.container.running).toBe(true);
      expect(env.container.destroyed).toEqual([]);
      expect(env.alarms.current).toBe(env.clock.now + CHECK_MS);
    }

    env.clock.now += IDLE_MS;
    await env.core.alarm();
    expect(env.container.destroyed).toEqual(["idle"]);
    expect(env.alarms.current).toBeNull();
  });

  test("a successful snapshot resets the failure count", async () => {
    quietConsole();
    const env = setup();
    await env.core.list(VM_WORKDIR);

    env.backups.hooks.backupError = new Error("bucket is down");
    env.clock.now += IDLE_MS;
    await env.core.alarm();
    env.clock.now += IDLE_MS;
    await env.core.alarm();

    env.backups.hooks.backupError = null;
    env.clock.now += IDLE_MS;
    await env.core.alarm();
    expect(env.container.destroyed).toEqual(["idle"]);

    await env.core.list(VM_WORKDIR);
    env.backups.hooks.backupError = new Error("bucket is down");
    env.clock.now += IDLE_MS;
    await env.core.alarm();
    env.clock.now += IDLE_MS;
    await env.core.alarm();
    expect(env.container.running).toBe(true);
    expect(env.container.destroyed).toEqual(["idle"]);
  });

  test("a backup that fails with ENOENT on another path counts as a failure", async () => {
    quietConsole();
    const env = setup();
    await env.core.list(VM_WORKDIR);
    env.backups.hooks.backupError = fileError("ENOENT", "/workspace/gone.txt");

    env.clock.now += IDLE_MS;
    await env.core.alarm();

    expect(env.container.destroyed).toEqual([]);
    expect(env.alarms.current).not.toBeNull();
  });

  test("a backup that fails with SandboxFileError ENOENT counts as nothing to save: the VM is destroyed and no failure is counted", async () => {
    quietConsole();
    const env = setup();
    await env.core.list(VM_WORKDIR);
    env.backups.hooks.backupError = fileError("ENOENT");

    env.clock.now += IDLE_MS;
    await env.core.alarm();

    expect(env.container.destroyed).toEqual(["idle"]);
    expect(env.alarms.current).toBeNull();
    expect(env.storage.has(SNAPSHOT_KEY)).toBe(false);
  });
});

describe("createVmCore: exec", () => {
  test("runs the command through timeout(1) with the seconds rounded up, in the home folder, with only a home folder as environment", async () => {
    const env = setup();
    env.container.answer = (command) =>
      command.at(-1) === "echo hi"
        ? {
            exit: 3,
            stderr: [bytes("err")],
            stdout: [bytes("out")],
          }
        : { exit: 0 };

    const result = await env.core.exec(input("echo hi", { timeoutMs: 90_500 }));

    const call = lastCall(env.container);
    expect(call.command).toEqual([
      "timeout",
      "-k",
      "2",
      "91",
      "bash",
      "-c",
      "echo hi",
    ]);
    expect(call.options?.cwd).toBe(VM_HOME_DIR);
    expect(call.options?.signal).toBeInstanceOf(AbortSignal);
    expect(call.options?.env).toEqual({ HOME: "/root" });
    expect(result).toEqual({
      exitCode: 3,
      stderr: "err",
      stdout: "out",
      timedOut: false,
      truncated: false,
    });
  });

  test("a command with no cwd runs in the home folder, not the scratch root", async () => {
    const env = setup();

    await env.core.exec(input("pwd"));

    const call = lastCall(env.container);
    expect(call.options?.cwd).toBe(VM_HOME_DIR);
    expect(call.options?.cwd).not.toBe(VM_WORKDIR);
  });

  test("passes a given cwd and env, and rounds a sub-second timeout up to one second", async () => {
    const env = setup();

    await env.core.exec(
      input("pwd", {
        cwd: "/tmp",
        env: { A: "1" },
        timeoutMs: 500,
      })
    );

    const call = lastCall(env.container);
    expect(call.command.slice(0, 4)).toEqual(["timeout", "-k", "2", "1"]);
    expect(call.options?.cwd).toBe("/tmp");
    expect(call.options?.env).toEqual({ A: "1", HOME: "/root" });
  });

  test("output below the cap comes back whole and not truncated", async () => {
    const env = setup();
    env.container.answer = () => ({ stdout: [bytes("hello")] });

    const result = await env.core.exec(input("cat", { maxOutputBytes: 100 }));

    expect(result.stdout).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  test("output over the cap is cut to that many bytes on a character boundary, and the process is still read to its end", async () => {
    const env = setup();
    // Ten "é" (two bytes each) in the first chunk, then two more chunks.
    env.container.answer = () => ({
      stdout: [bytes("é".repeat(10)), bytes("more"), bytes("tail")],
    });

    const result = await env.core.exec(input("big", { maxOutputBytes: 7 }));

    expect(result.stdout).toBe("ééé");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(7);
    expect(result.truncated).toBe(true);
    expect(lastCall(env.container).unread()).toBe(0);
  });

  test("a process that never ends is aborted after the wall time, the TERM-to-KILL wait and the grace: timedOut true and exit 124", async () => {
    const realSetTimeout = globalThis.setTimeout;
    // The grace is 3 s. Delays of 3 s or more fire at once so the test stays fast.
    const shortGrace = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
      ...rest: unknown[]
    ) =>
      realSetTimeout(
        handler,
        ms !== undefined && ms >= 3000 ? 0 : ms,
        ...rest
      )) as unknown as typeof setTimeout);
    try {
      const env = setup();
      env.container.answer = (command) =>
        command.at(-1) === "forever" ? { hang: true } : { exit: 0 };

      const result = await env.core.exec(input("forever", { timeoutMs: 20 }));

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(124);
      expect(lastCall(env.container).options?.signal?.aborted).toBe(true);
    } finally {
      shortGrace.mockRestore();
    }
  });

  test("a command that exits while a background child holds its output open returns the exit code and the output so far", async () => {
    const env = setup();
    env.container.answer = (command) =>
      command.length === 1
        ? { exit: 0 }
        : { exit: 0, openStreams: true, stdout: [bytes("started")] };

    const result = await env.core.exec(
      input("server &", { timeoutMs: 60_000 })
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("started");
    expect(result.timedOut).toBe(false);
  });

  test("the last-resort abort waits for the wall time, the TERM-to-KILL wait of timeout and the grace", async () => {
    const delays: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const recorder = spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms !== undefined) {
        delays.push(ms);
      }
      return realSetTimeout(handler, ms, ...rest);
    }) as unknown as typeof setTimeout);
    try {
      const env = setup();
      await env.core.exec(input("true", { timeoutMs: 1500 }));
      // 2 s wall time (rounded up), 2 s for KILL, 3 s grace.
      expect(delays).toContain(7000);
    } finally {
      recorder.mockRestore();
    }
  });

  test("an exit code of 124 from the process counts as a timeout", async () => {
    const env = setup();
    env.container.answer = (command) =>
      command.length === 1 ? { exit: 0 } : { exit: 124 };

    const result = await env.core.exec(input("sleep 99"));

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
  });

  test("an exit code of 137 after the wall time is a timeout, and before it is a command that was killed", async () => {
    const env = setup();
    env.container.answer = (command) =>
      command.length === 1 ? { exit: 0 } : { exit: 137 };
    const early = await env.core.exec(input("kill -9 $$", { timeoutMs: 5000 }));
    expect(early.timedOut).toBe(false);

    env.container.answer = (command) => {
      if (command.length > 1) {
        env.clock.now += 5000;
      }
      return command.length === 1 ? { exit: 0 } : { exit: 137 };
    };
    const late = await env.core.exec(input("sleep 99", { timeoutMs: 5000 }));
    expect(late.exitCode).toBe(137);
    expect(late.timedOut).toBe(true);
  });

  test("a normal exit is not a timeout", async () => {
    const env = setup();
    env.container.answer = () => ({ exit: 0 });

    const result = await env.core.exec(input("true"));

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });
});

describe("createVmCore: files", () => {
  test("a SandboxFileError with a known code becomes a VmFileError with that code", async () => {
    const env = setup();
    await env.core.list(VM_WORKDIR);
    env.files.hooks.fail = fileError("ENOENT");

    await expect(env.core.readFile("/workspace/x")).rejects.toBeInstanceOf(
      VmFileError
    );
    await expect(env.core.readFile("/workspace/x")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("an unknown file error code becomes UNKNOWN", async () => {
    const env = setup();
    await env.core.list(VM_WORKDIR);
    env.files.hooks.fail = fileError("EWEIRD");

    await expect(env.core.mkdir("/workspace/x")).rejects.toMatchObject({
      code: "UNKNOWN",
    });
  });

  test("other errors pass through unchanged", async () => {
    const env = setup();
    await env.core.list(VM_WORKDIR);
    const plain = new Error("disk gone");
    env.files.hooks.fail = plain;

    await expect(env.core.remove("/workspace/x")).rejects.toBe(plain);
  });

  test("stat maps a bigint size to a number and the type to a kind", async () => {
    const env = setup();
    env.files.entries.set("/workspace/a.txt", { size: 42n, type: "file" });
    env.files.entries.set("/workspace/d", { size: 0n, type: "directory" });

    await expect(env.core.stat("/workspace/a.txt")).resolves.toEqual({
      kind: "file",
      mtimeMs: 1234,
      size: 42,
    });
    await expect(env.core.stat("/workspace/d")).resolves.toMatchObject({
      kind: "directory",
    });
  });

  test("list maps the directory entries", async () => {
    const env = setup();
    env.files.listing.set(VM_WORKDIR, [
      { name: "a.txt", type: "file" },
      { name: "sub", type: "directory" },
      { name: "link", type: "symlink" },
    ]);

    await expect(env.core.list(VM_WORKDIR)).resolves.toEqual([
      { kind: "file", name: "a.txt" },
      { kind: "directory", name: "sub" },
      { kind: "symlink", name: "link" },
    ]);
  });

  test("writeFile and readFile round-trip the bytes", async () => {
    const env = setup();
    const data = new Uint8Array([0, 255, 10, 200]);

    await env.core.writeFile("/workspace/b.bin", data);

    await expect(env.core.readFile("/workspace/b.bin")).resolves.toEqual(data);
  });
});
