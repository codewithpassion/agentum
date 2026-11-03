import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_HOME, AGENT_STAT } from "./agent-user.ts";
import type { CommandResult, CommandRunner } from "./command.ts";
import { prepareWorkDir, workDirPath } from "./workdir.ts";

const ok: CommandResult = { exitCode: 0, stderr: "", stdout: "" };

const missing: CommandResult = {
  exitCode: 1,
  stderr: "stat: cannot statx: No such file or directory",
  stdout: "",
};

/**
 * A runner that records each command and answers with `answer`. The stat for
 * the pre-rename folder answers `legacy`, missing unless a test says so.
 */
const fakeRun = (
  answer: CommandResult = ok,
  legacy: CommandResult = missing
): { calls: string[][]; run: CommandRunner } => {
  const calls: string[][] = [];
  const run: CommandRunner = (command) => {
    calls.push(command);
    return Promise.resolve(command[4] === AGENT_STAT ? legacy : answer);
  };
  return { calls, run };
};

const legacyStat = [
  "sudo",
  "-n",
  "-u",
  "hm-agent",
  "/usr/bin/stat",
  `${AGENT_HOME}/harbourmaster`,
];

const dirs: string[] = [];

const tempDirectory = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "agentum-workdir-"));
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
    "/home/dom/agentum/ws1/agent-2/work"
  );
});

test("multi-user runs mkdir, rm, then mkdir tmp as hm-agent under the agent home", async () => {
  const { calls, run } = fakeRun();

  const dir = await prepareWorkDir({
    agentId: "a1",
    run,
    singleUser: false,
    workspaceId: "w1",
  });

  const workDir = `${AGENT_HOME}/agentum/w1/a1/work`;
  expect(dir).toBe(workDir);
  expect(calls).toEqual([
    legacyStat,
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
      `${workDir}/inbox`,
      `${workDir}/tmp`,
    ],
    ["sudo", "-n", "-u", "hm-agent", "/bin/mkdir", "-p", `${workDir}/tmp`],
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
  expect(calls).toHaveLength(2);
  expect(calls[1]?.[4]).toBe("/bin/mkdir");
});

test("single-user creates the dir and empties .claude, .mcp.json, inbox and tmp only", async () => {
  const home = tempDirectory();
  const dir = workDirPath(home, "w1", "a1");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), "{}");
  writeFileSync(join(dir, ".mcp.json"), "{}");
  mkdirSync(join(dir, "inbox"));
  writeFileSync(join(dir, "inbox", "old.txt"), "from an earlier run");
  mkdirSync(join(dir, "tmp"));
  writeFileSync(join(dir, "tmp", "scratch.txt"), "from an earlier run");
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
  expect(existsSync(join(dir, "tmp", "scratch.txt"))).toBe(false);
  expect(existsSync(join(dir, "tmp"))).toBe(true);
  expect(readdirSync(join(dir, "tmp"))).toEqual([]);
  expect(existsSync(join(dir, "keep.txt"))).toBe(true);
  expect(calls).toEqual([]);
});

test("single-user keeps library/ and its manifest, like the rest of home", async () => {
  const home = tempDirectory();
  const dir = workDirPath(home, "w1", "a1");
  mkdirSync(join(dir, "library", "agents", "ada"), { recursive: true });
  writeFileSync(join(dir, "library", "agents", "ada", "notes.md"), "mine");
  writeFileSync(join(dir, "library.manifest.json"), "[]");
  const { run } = fakeRun();

  await prepareWorkDir({
    agentId: "a1",
    daemonHome: home,
    run,
    singleUser: true,
    workspaceId: "w1",
  });

  expect(existsSync(join(dir, "library", "agents", "ada", "notes.md"))).toBe(
    true
  );
  expect(existsSync(join(dir, "library.manifest.json"))).toBe(true);
});

test("single-user creates a missing dir with an empty tmp without touching the runner", async () => {
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
  expect(existsSync(join(dir, "tmp"))).toBe(true);
  expect(readdirSync(join(dir, "tmp"))).toEqual([]);
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

test("multi-user keeps using the harbourmaster folder of an install from before the rename", async () => {
  const { calls, run } = fakeRun(ok, ok);

  const dir = await prepareWorkDir({
    agentId: "a1",
    run,
    singleUser: false,
    workspaceId: "w1",
  });

  expect(dir).toBe(`${AGENT_HOME}/harbourmaster/w1/a1/work`);
  expect(calls[0]).toEqual(legacyStat);
  expect(calls[1]).toEqual([
    "sudo",
    "-n",
    "-u",
    "hm-agent",
    "/bin/mkdir",
    "-p",
    `${AGENT_HOME}/harbourmaster/w1/a1/work`,
  ]);
});

test("single-user keeps using the harbourmaster folder of an install from before the rename", async () => {
  const home = tempDirectory();
  const legacy = workDirPath(home, "w1", "a1", "harbourmaster");
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, "keep.txt"), "kept");
  const { run } = fakeRun();

  const dir = await prepareWorkDir({
    agentId: "a1",
    daemonHome: home,
    run,
    singleUser: true,
    workspaceId: "w1",
  });

  expect(dir).toBe(legacy);
  expect(existsSync(join(dir, "keep.txt"))).toBe(true);
  expect(existsSync(join(home, "agentum"))).toBe(false);
});
