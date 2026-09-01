import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecRunner, type ExecRunner } from "./exec";
import { TOOL_OUTPUT_MAX_BYTES } from "./output";

const EXEC_MAX_MS = 10_000;

let root = "";
let exec: ExecRunner;

const ok = async (request: Parameters<ExecRunner>[0]) => {
  const result = await exec(request);
  if (!result.ok) {
    throw new Error(`exec failed: ${result.reason}`);
  }
  return result;
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "computerd-exec-")));
  exec = createExecRunner(root, EXEC_MAX_MS);
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("exec", () => {
  test("captures stdout and the exit code", async () => {
    const result = await ok({ command: "echo hello" });
    expect(result.stdout).toBe("hello\n");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("reports a non-zero exit code and stderr", async () => {
    const result = await ok({ command: "echo boom >&2; exit 3" });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("boom\n");
  });

  test("runs in the root by default", async () => {
    const result = await ok({ command: "pwd" });
    expect(result.stdout.trim()).toBe(root);
  });

  test("runs in a cwd inside the root", async () => {
    await mkdir(join(root, "work"));
    const result = await ok({ command: "pwd", cwd: "/work" });
    expect(result.stdout.trim()).toBe(join(root, "work"));
  });

  test("refuses a cwd outside the root", async () => {
    const result = await exec({ command: "pwd", cwd: "/../.." });
    expect(result.ok).toBe(false);
  });

  test("refuses an empty command", async () => {
    const result = await exec({ command: "   " });
    expect(result).toEqual({ ok: false, reason: "A command is required." });
  });

  test("kills the whole process group at the timeout", async () => {
    const startedAt = Date.now();
    // The backgrounded child outlives the shell: if only the shell were killed,
    // its inherited pipe would keep this call waiting for the full five seconds.
    const result = await ok({
      command: "sleep 5 & sleep 5",
      timeoutMs: 300,
    });
    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("timed out after 300ms");
  });

  test("caps the timeout at the daemon's maximum", async () => {
    const runner = createExecRunner(root, 200);
    const result = await runner({ command: "sleep 5", timeoutMs: 60_000 });
    expect(result.ok && result.exitCode).toBe(124);
  });

  test("truncates output and says how much was dropped", async () => {
    const result = await ok({ command: "yes 0123456789 | head -n 4000" });
    const [body, note] = result.stdout.split("\n[truncated:");
    expect(note).toContain("showing the first");
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(
      TOOL_OUTPUT_MAX_BYTES
    );
    expect(result.stdout).toContain("of 44000 bytes]");
  });

  test("runs one command at a time", async () => {
    const logPath = join(root, "order.log");
    const write = (marker: string) => `echo ${marker} >> ${logPath}`;
    await Promise.all([
      exec({ command: `${write("start-1")}; sleep 0.3; ${write("end-1")}` }),
      exec({ command: `${write("start-2")}; ${write("end-2")}` }),
    ]);
    expect(
      (await Bun.file(logPath).text()).split("\n").filter(Boolean)
    ).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});
