import { expect, test } from "bun:test";
import { durableVm } from "./durable-vm.ts";
import type { VmExecInput, VmExecResult } from "./vm-port.ts";
import type { VmSession } from "./vm-session.ts";

interface Call {
  args: unknown[];
  method: string;
  target: string;
}

/**
 * A fake namespace. `idFromName` returns `{ name }`, and `get` returns a stub
 * that records each call with the name of the object it was got for.
 */
const recordingNamespace = () => {
  const names: string[] = [];
  const targets: string[] = [];
  const calls: Call[] = [];
  const namespace = {
    get: (id: { name: string }) => {
      const target = id.name;
      targets.push(target);
      return {
        exec: (input: VmExecInput): Promise<VmExecResult> => {
          calls.push({ args: [input], method: "exec", target });
          return Promise.resolve({
            exitCode: 0,
            stderr: "",
            stdout: "ok\n",
            timedOut: false,
            truncated: false,
          });
        },
        list: (path: string) => {
          calls.push({ args: [path], method: "list", target });
          return Promise.resolve({
            ok: true,
            value: [{ kind: "file", name: "a.txt" }],
          });
        },
        lockLibrary: (owner: string, ttlMs: number) => {
          calls.push({ args: [owner, ttlMs], method: "lockLibrary", target });
          return Promise.resolve(true);
        },
        unlockLibrary: (owner: string) => {
          calls.push({ args: [owner], method: "unlockLibrary", target });
          return Promise.resolve();
        },
      };
    },
    idFromName: (name: string) => {
      names.push(name);
      return { name };
    },
  };
  return {
    calls,
    names,
    namespace: namespace as unknown as DurableObjectNamespace<VmSession>,
    targets,
  };
};

test("two handles built from one agent id name the same object", () => {
  const { names, namespace, targets } = recordingNamespace();

  durableVm(namespace, "agent-1");
  durableVm(namespace, "agent-1");

  expect(names).toEqual(["agent-1", "agent-1"]);
  expect(targets).toEqual(["agent-1", "agent-1"]);
});

test("handles built from different agent ids name different objects", () => {
  const { names, namespace, targets } = recordingNamespace();

  durableVm(namespace, "agent-1");
  durableVm(namespace, "agent-2");

  expect(names).toEqual(["agent-1", "agent-2"]);
  expect(targets).toEqual(["agent-1", "agent-2"]);
});

test("exec and file calls on a handle reach the stub it was built with", async () => {
  const { calls, namespace } = recordingNamespace();
  const vm = durableVm(namespace, "agent-1");
  const input: VmExecInput = {
    command: "ls",
    maxOutputBytes: 1024,
    timeoutMs: 1000,
  };

  const result = await vm.exec(input);
  const listed = await vm.list("/workspace/home");

  expect(result.stdout).toBe("ok\n");
  expect(listed).toEqual([{ kind: "file", name: "a.txt" }]);
  expect(calls).toEqual([
    { args: [input], method: "exec", target: "agent-1" },
    { args: ["/workspace/home"], method: "list", target: "agent-1" },
  ]);
});

test("the library lock calls reach the stub of the agent", async () => {
  const { calls, namespace } = recordingNamespace();
  const vm = durableVm(namespace, "agent-1");

  expect(await vm.lockLibrary("owner", 5000)).toBe(true);
  await vm.unlockLibrary("owner");

  expect(calls).toEqual([
    { args: ["owner", 5000], method: "lockLibrary", target: "agent-1" },
    { args: ["owner"], method: "unlockLibrary", target: "agent-1" },
  ]);
});
