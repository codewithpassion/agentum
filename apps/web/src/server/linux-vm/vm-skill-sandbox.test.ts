import { describe, expect, test } from "bun:test";
import type { SandboxRunInput } from "../skill-scripts/sandbox-port.ts";
import { TIMEOUT_EXIT_CODE } from "../skill-scripts/sandbox-port.ts";
import { bytesOf, createFakeVm, type FakeVm, textOf } from "./fake-vm.ts";
import { VM_WORKDIR } from "./vm-port.ts";
import { vmSkillSandbox } from "./vm-skill-sandbox.ts";

const FOLDER = `${VM_WORKDIR}/skills/shout`;

const inputOf = (
  overrides: Partial<SandboxRunInput> = {}
): SandboxRunInput => ({
  args: [],
  entry: "scripts/hello.ts",
  files: [
    { bytes: bytesOf("---\nname: shout\n---\n"), path: "SKILL.md" },
    { bytes: bytesOf("console.log('hi');"), path: "scripts/hello.ts" },
  ],
  maxOutputBytes: 4096,
  skill: "shout",
  timeoutMs: 5000,
  ...overrides,
});

const setup = (): {
  sandbox: ReturnType<typeof vmSkillSandbox>;
  vm: FakeVm;
} => {
  const vm = createFakeVm();
  return { sandbox: vmSkillSandbox(vm), vm };
};

describe("vmSkillSandbox", () => {
  test("places every file under the skill folder with its bytes", async () => {
    const { sandbox, vm } = setup();
    await sandbox.run(inputOf());
    expect(textOf(vm.files.get(`${FOLDER}/SKILL.md`))).toBe(
      "---\nname: shout\n---\n"
    );
    expect(textOf(vm.files.get(`${FOLDER}/scripts/hello.ts`))).toBe(
      "console.log('hi');"
    );
  });

  test("creates nested folders for files that need them", async () => {
    const { sandbox, vm } = setup();
    await sandbox.run(
      inputOf({
        entry: "a/b/c/run.ts",
        files: [{ bytes: bytesOf("x"), path: "a/b/c/run.ts" }],
      })
    );
    expect(vm.folders.has(`${FOLDER}/a`)).toBe(true);
    expect(vm.folders.has(`${FOLDER}/a/b`)).toBe(true);
    expect(vm.folders.has(`${FOLDER}/a/b/c`)).toBe(true);
    expect(textOf(vm.files.get(`${FOLDER}/a/b/c/run.ts`))).toBe("x");
  });

  test("a second run over an existing skill folder refreshes the files", async () => {
    const { sandbox, vm } = setup();
    await sandbox.run(inputOf());
    await sandbox.run(
      inputOf({ files: [{ bytes: bytesOf("new"), path: "scripts/hello.ts" }] })
    );
    expect(textOf(vm.files.get(`${FOLDER}/scripts/hello.ts`))).toBe("new");
  });

  test("runs bun on the entry's absolute path, quoting each argument", async () => {
    const { sandbox, vm } = setup();
    await sandbox.run(inputOf({ args: ["a b", "it's"] }));
    expect(vm.execCalls).toHaveLength(1);
    expect(vm.execCalls[0]?.command).toBe(
      `bun '${FOLDER}/scripts/hello.ts' 'a b' 'it'\\''s'`
    );
  });

  test("with no args the command is bun and the entry only", async () => {
    const { sandbox, vm } = setup();
    await sandbox.run(inputOf());
    expect(vm.execCalls[0]?.command).toBe(`bun '${FOLDER}/scripts/hello.ts'`);
  });

  test("the command runs in the workdir, with the timeout and output cap", async () => {
    const { sandbox, vm } = setup();
    await sandbox.run(inputOf({ maxOutputBytes: 123, timeoutMs: 4567 }));
    const [call] = vm.execCalls;
    expect(call?.cwd).toBe(VM_WORKDIR);
    expect(call?.maxOutputBytes).toBe(123);
    expect(call?.timeoutMs).toBe(4567);
  });

  test("the exec input has no env field at all", async () => {
    const { sandbox, vm } = setup();
    await sandbox.run(inputOf());
    expect(vm.execCalls[0]).not.toHaveProperty("env");
  });

  test("a non-zero exit code, stdout and stderr pass through", async () => {
    const { sandbox, vm } = setup();
    vm.onExec = () => ({
      exitCode: 3,
      stderr: "bad",
      stdout: "out",
      timedOut: false,
      truncated: false,
    });
    expect(await sandbox.run(inputOf())).toEqual({
      exitCode: 3,
      stderr: "bad",
      stdout: "out",
    });
  });

  test("a timeout is exit 124 with the note first in stderr", async () => {
    const { sandbox, vm } = setup();
    vm.onExec = () => ({
      exitCode: 137,
      stderr: "real stderr",
      stdout: "partial",
      timedOut: true,
      truncated: false,
    });
    expect(await sandbox.run(inputOf({ timeoutMs: 2500 }))).toEqual({
      exitCode: TIMEOUT_EXIT_CODE,
      stderr: "timed out after 2.5 s\nreal stderr",
      stdout: "partial",
    });
  });

  test("a timeout with no stderr has only the note", async () => {
    const { sandbox, vm } = setup();
    vm.onExec = () => ({
      exitCode: 137,
      stderr: "",
      stdout: "",
      timedOut: true,
      truncated: false,
    });
    expect(await sandbox.run(inputOf({ timeoutMs: 30_000 }))).toEqual({
      exitCode: TIMEOUT_EXIT_CODE,
      stderr: "timed out after 30 s",
      stdout: "",
    });
  });

  test("a rejecting VM rejects the run", async () => {
    const { sandbox, vm } = setup();
    vm.onExec = () => Promise.reject(new Error("vm is down"));
    await expect(sandbox.run(inputOf())).rejects.toThrow("vm is down");
  });

  test("a rejecting file write rejects the run", async () => {
    const vm = createFakeVm();
    vm.writeFile = () => Promise.reject(new Error("disk full"));
    await expect(vmSkillSandbox(vm).run(inputOf())).rejects.toThrow(
      "disk full"
    );
    expect(vm.execCalls).toEqual([]);
  });
});
