import { expect, test } from "bun:test";
import {
  canRunAsAgent,
  resolveClaudeBinary,
  sudoersFile,
  sudoersLine,
  sudoersPath,
} from "./agent-user.ts";
import type { CommandResult, CommandRunner } from "./command.ts";

const ok = (stdout = ""): CommandResult => ({
  exitCode: 0,
  stderr: "",
  stdout,
});
const failed: CommandResult = { exitCode: 1, stderr: "no", stdout: "" };

/** A runner that answers from `answers` by the command's first word. */
const fakeRun =
  (
    answers: Record<string, CommandResult>,
    calls: string[][] = []
  ): CommandRunner =>
  (command) => {
    calls.push(command);
    return Promise.resolve(answers[command[0] ?? ""] ?? failed);
  };

test("the sudoers line names the exact binary path", () => {
  expect(sudoersLine("dom", "/home/dom/.local/bin/claude")).toBe(
    "dom ALL=(hm-agent) NOPASSWD: /home/dom/.local/bin/claude"
  );
});

test("the sudoers line escapes characters sudoers would split on", () => {
  expect(sudoersLine("dom", "/opt/my tools/claude,v2")).toBe(
    "dom ALL=(hm-agent) NOPASSWD: /opt/my\\ tools/claude\\,v2"
  );
});

test("the drop-in file ends with a newline and holds the one rule", () => {
  const file = sudoersFile("dom", "/usr/bin/claude");
  expect(file.endsWith("\n")).toBe(true);
  expect(file).toContain("dom ALL=(hm-agent) NOPASSWD: /usr/bin/claude\n");
});

test("the drop-in path has no dot, which sudo would skip", () => {
  expect(sudoersPath("dom")).toBe("/etc/sudoers.d/harbourmaster-dom");
  expect(sudoersPath("john.doe")).toBe("/etc/sudoers.d/harbourmaster-john_doe");
});

test("resolveClaudeBinary follows which and realpath", async () => {
  const run = fakeRun({
    realpath: ok("/opt/claude/bin/claude\n"),
    which: ok("/usr/local/bin/claude\n"),
  });
  expect(await resolveClaudeBinary(run)).toBe("/opt/claude/bin/claude");
});

test("resolveClaudeBinary is undefined when claude is not on the PATH", async () => {
  expect(await resolveClaudeBinary(fakeRun({}))).toBeUndefined();
});

test("resolveClaudeBinary keeps the override when realpath fails", async () => {
  const calls: string[][] = [];
  const run = fakeRun({}, calls);
  expect(await resolveClaudeBinary(run, "/x/claude")).toBe("/x/claude");
  expect(calls.some((call) => call[0] === "which")).toBe(false);
});

test("canRunAsAgent asks sudo to list the exact binary", async () => {
  const calls: string[][] = [];
  const run = fakeRun({ sudo: ok("/usr/bin/claude\n") }, calls);
  expect(await canRunAsAgent(run, "/usr/bin/claude")).toBe(true);
  expect(calls).toEqual([
    ["sudo", "-n", "-u", "hm-agent", "-l", "/usr/bin/claude"],
  ]);
});

test("canRunAsAgent is false when sudo refuses", async () => {
  expect(await canRunAsAgent(fakeRun({}), "/usr/bin/claude")).toBe(false);
});
