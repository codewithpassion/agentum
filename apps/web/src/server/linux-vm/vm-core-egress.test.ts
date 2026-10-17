import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  createVmCore,
  type VmBackups,
  type VmContainer,
  type VmFiles,
  type VmNetwork,
  type VmProcess,
  type VmStorage,
} from "./vm-core.ts";
import type { VmEgress, VmEgressRun, VmExecInput } from "./vm-port.ts";

const IDLE_MS = 300_000;
const LABEL = "session-1";
const CA_PATH = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

const RUN: VmEgressRun = {
  agentId: "agent-fake",
  runId: "run-fake",
  workspaceId: "workspace-fake",
};
const EGRESS: VmEgress = {
  hosts: ["api.example.test", "*.example.test"],
  run: RUN,
};

type ExecOptions = NonNullable<Parameters<VmContainer["exec"]>[1]>;

interface FakeCall {
  command: string[];
  options: ExecOptions | undefined;
}

/** A fake container. `answer` gives the exit code of each command; the probe `true` exits 0 unless told otherwise. */
const createFakeContainer = () => {
  let running = false;
  let starts = 0;
  const calls: FakeCall[] = [];
  const destroyed: string[] = [];
  const container = {
    answer: (_command: string[]): number => 0,
    calls,
    destroy: (reason: string) => {
      running = false;
      destroyed.push(reason);
      return Promise.resolve();
    },
    destroyed,
    exec: (command: string[], options?: ExecOptions): Promise<VmProcess> => {
      calls.push({ command, options });
      return Promise.resolve({
        exitCode: Promise.resolve(container.answer(command)),
        stderr: null,
        stdout: null,
      });
    },
    get running() {
      return running;
    },
    setInactivityTimeout: () => Promise.resolve(),
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

type FakeContainer = ReturnType<typeof createFakeContainer>;

/** A fake network. `hooks.fail` makes every intercept reject. */
const createFakeNetwork = () => {
  const calls: { hosts: readonly string[]; run: VmEgressRun }[] = [];
  const hooks: { fail: Error | null } = { fail: null };
  const network: VmNetwork = {
    intercept: (hosts, run) => {
      calls.push({ hosts: [...hosts], run });
      return hooks.fail === null
        ? Promise.resolve()
        : Promise.reject(hooks.fail);
    },
  };
  return { calls, hooks, network };
};

const createFakeFiles = (): VmFiles => ({
  mkdir: () => Promise.resolve(),
  readDirectory: () => Promise.resolve([]),
  readFile: () => Promise.resolve(new Response(new Uint8Array())),
  remove: () => Promise.resolve(),
  rename: () => Promise.resolve(),
  stat: () =>
    Promise.resolve({ modifiedAt: new Date(0), size: 0n, type: "file" }),
  writeFile: () => Promise.resolve(),
});

const createFakeBackups = (): VmBackups => {
  let made = 0;
  return {
    backup: (options) => {
      made += 1;
      return Promise.resolve({ dir: options.dir, id: `snap-${made}` });
    },
    delete: () => Promise.resolve(),
    restore: () => Promise.resolve(),
  };
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

const setup = (withNetwork = true) => {
  const clock = { now: 1_000_000 };
  const container = createFakeContainer();
  const network = createFakeNetwork();
  const { map, storage } = createFakeStorage();
  const core = createVmCore({
    backups: createFakeBackups(),
    container,
    deleteAlarm: () => Promise.resolve(),
    files: createFakeFiles(),
    idleMs: IDLE_MS,
    label: LABEL,
    ...(withNetwork ? { network: network.network } : {}),
    now: () => clock.now,
    setAlarm: () => Promise.resolve(),
    sleep: (ms) => {
      clock.now += ms;
      return Promise.resolve();
    },
    storage,
  });
  return { container, core, network, storage: map };
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

/** The commands that trust the platform's CA. */
const trustCalls = (container: FakeContainer): FakeCall[] =>
  container.calls.filter(
    (call) =>
      call.command[0] === "sh" &&
      call.command[1] === "-c" &&
      call.command[2]?.includes("update-ca-certificates") === true
  );

const lastCall = (container: FakeContainer): FakeCall => {
  const call = container.calls.at(-1);
  if (call === undefined) {
    throw new Error("no exec call was made");
  }
  return call;
};

afterEach(() => {
  mock.restore();
});

describe("createVmCore: setEgress", () => {
  test("on a cold VM it starts the VM, intercepts the hosts once and trusts the CA once", async () => {
    const env = setup();

    await env.core.setEgress(EGRESS);

    expect(env.container.starts).toBe(1);
    expect(env.network.calls).toEqual([{ hosts: EGRESS.hosts, run: RUN }]);
    expect(trustCalls(env.container)).toHaveLength(1);
    expect(trustCalls(env.container)[0]?.command).toEqual([
      "sh",
      "-c",
      expect.stringContaining("update-ca-certificates"),
    ]);
  });

  test("a second call intercepts again but does not run the trust step again", async () => {
    const env = setup();
    await env.core.setEgress(EGRESS);

    await env.core.setEgress({ ...EGRESS, hosts: ["other.example.test"] });

    expect(env.network.calls).toEqual([
      { hosts: EGRESS.hosts, run: RUN },
      { hosts: ["other.example.test"], run: RUN },
    ]);
    expect(trustCalls(env.container)).toHaveLength(1);
  });

  test("empty hosts intercept nothing and run no trust step", async () => {
    const env = setup();

    await env.core.setEgress({ hosts: [], run: RUN });

    expect(env.network.calls).toEqual([]);
    expect(trustCalls(env.container)).toEqual([]);
  });

  test("with no network dependency it resolves and changes nothing", async () => {
    const env = setup(false);

    await expect(env.core.setEgress(EGRESS)).resolves.toBeUndefined();

    expect(env.network.calls).toEqual([]);
    expect(trustCalls(env.container)).toEqual([]);
  });

  test("an intercept that throws rejects setEgress", async () => {
    const env = setup();
    env.network.hooks.fail = new Error("intercept refused");

    await expect(env.core.setEgress(EGRESS)).rejects.toThrow(
      "intercept refused"
    );
  });

  test("a trust step with exit code 1 rejects setEgress, and the VM is not marked trusted", async () => {
    const env = setup();
    env.container.answer = (command) => (command[0] === "sh" ? 1 : 0);

    await expect(env.core.setEgress(EGRESS)).rejects.toThrow("could not trust");

    await env.core.exec(input("true"));
    expect(lastCall(env.container).options?.env).toEqual({ HOME: "/root" });
  });
});

describe("createVmCore: egress across sleep and exec", () => {
  test("after the VM sleeps, the next exec starts it and applies the stored egress and trust again", async () => {
    const env = setup();
    await env.core.setEgress(EGRESS);

    await expect(env.core.sleepNow()).resolves.toBe(true);
    expect(env.container.running).toBe(false);

    await env.core.exec(input("true"));

    expect(env.container.starts).toBe(2);
    expect(env.network.calls).toEqual([
      { hosts: EGRESS.hosts, run: RUN },
      { hosts: EGRESS.hosts, run: RUN },
    ]);
    expect(trustCalls(env.container)).toHaveLength(2);
  });

  test("exec env holds NODE_EXTRA_CA_CERTS only after the CA is trusted", async () => {
    const env = setup();
    await env.core.exec(input("true", { env: { A: "1" } }));
    expect(lastCall(env.container).options?.env).toEqual({
      A: "1",
      HOME: "/root",
    });

    await env.core.setEgress(EGRESS);
    await env.core.exec(input("true", { env: { A: "1" } }));

    expect(lastCall(env.container).options?.env).toEqual({
      A: "1",
      HOME: "/root",
      NODE_EXTRA_CA_CERTS: CA_PATH,
    });
  });

  test("an intercept that throws inside start does not fail exec, and warns with the message only", async () => {
    const env = setup();
    await env.core.setEgress(EGRESS);
    await env.core.sleepNow();
    env.network.hooks.fail = new Error("intercept is down");
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await env.core.exec(input("true"));

    expect(result.exitCode).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.join(" ")).toContain("intercept is down");
  });
});
