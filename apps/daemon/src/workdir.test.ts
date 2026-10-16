import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_HOME } from "./agent-user.ts";
import type { CommandResult, CommandRunner } from "./command.ts";
import { prepareWorkDir, workDirPath } from "./workdir.ts";

const ok: CommandResult = { exitCode: 0, stderr: "", stdout: "" };

/** A runner that records each command and answers with `answer`. */
const fakeRun = (
  answer: CommandResult = ok
): { calls: string[][]; run: CommandRunner } => {
  const calls: string[][] = [];
  const run: CommandRunner = (command) => {
    calls.push(command);
    return Promise.resolve(answer);
  };
  return { calls, run };
};

const dirs: string[] = [];

const tempDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "harbourmaster-workdir-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("workDirPath lays out home, workspace, agent and work", () => {
  expect(workDirPath("/home/dom", "ws1", "agent-2")).toBe(
    "/home/dom/harbourmaster/ws1/agent-2/work"
  );
});

test("multi-user runs mkdir then rm as hm-agent under the agent home", async () => {
  const { calls, run } = fakeRun();

  const dir = await prepareWorkDir({
    agentId: "a1",
    run,
    singleUser: false,
    workspaceId: "w1",
  });

  const workDir = `${AGENT_HOME}/harbourmaster/w1/a1/work`;
  expect(dir).toBe(workDir);
  expect(calls).toEqual([
    ["sudo", "-n", "-u", "hm-agent", "/bin/mkdir", "-p", workDir],
    [
      "sudo",
      "-n",
      "-u",
      "hm-agent",
      "/bin/rm",
      "-rf",
      `${workDir}/.claude`,
      `${workDir}/.mcp.json`,
    ],
  ]);
});

test("a failing mkdir throws with the step and stderr, and skips the rm", async () => {
  const { calls, run } = fakeRun({
    exitCode: 1,
    stderr: "  mkdir: cannot create directory: Permission denied\n",
    stdout: "",
  });

  await expect(
    prepareWorkDir({ agentId: "a1", run, singleUser: false, workspaceId: "w1" })
  ).rejects.toThrow(
    "mkdir failed: mkdir: cannot create directory: Permission denied"
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[4]).toBe("/bin/mkdir");
});

test("single-user creates the dir and empties .claude, .mcp.json and inbox only", async () => {
  const home = tempDirectory();
  const dir = workDirPath(home, "w1", "a1");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), "{}");
  writeFileSync(join(dir, ".mcp.json"), "{}");
  mkdirSync(join(dir, "inbox"));
  writeFileSync(join(dir, "inbox", "old.txt"), "from an earlier run");
  writeFileSync(join(dir, "keep.txt"), "kept");
  const { calls, run } = fakeRun();

  const returned = await prepareWorkDir({
    agentId: "a1",
    daemonHome: home,
    run,
    singleUser: true,
    workspaceId: "w1",
  });

  expect(returned).toBe(dir);
  expect(existsSync(join(dir, ".claude"))).toBe(false);
  expect(existsSync(join(dir, ".mcp.json"))).toBe(false);
  expect(existsSync(join(dir, "inbox"))).toBe(false);
  expect(existsSync(join(dir, "keep.txt"))).toBe(true);
  expect(calls).toEqual([]);
});

test("single-user creates a missing dir without touching the runner", async () => {
  const home = tempDirectory();
  const { calls, run } = fakeRun();

  const dir = await prepareWorkDir({
    agentId: "a1",
    daemonHome: home,
    run,
    singleUser: true,
    workspaceId: "w1",
  });

  expect(existsSync(dir)).toBe(true);
  expect(calls).toEqual([]);
});

test("ids that could escape the layout are rejected", async () => {
  const { calls, run } = fakeRun();
  const bad = ["", "../x", "a/b", "a.b", "a b"];

  for (const id of bad) {
    expect(() => workDirPath("/home/dom", id, "a1")).toThrow();
    expect(() => workDirPath("/home/dom", "w1", id)).toThrow();
  }
  const attempts = bad.flatMap((id) => [
    prepareWorkDir({ agentId: id, run, singleUser: false, workspaceId: "w1" }),
    prepareWorkDir({ agentId: "a1", run, singleUser: false, workspaceId: id }),
  ]);
  await Promise.all(
    attempts.map((attempt) => expect(attempt).rejects.toThrow())
  );
  expect(calls).toEqual([]);
});
