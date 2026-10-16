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

test("the sudoers line names the exact binary path, plus mkdir and rm", () => {
  expect(sudoersLine("dom", "/home/dom/.local/bin/claude")).toBe(
    "dom ALL=(hm-agent) CWD=* NOPASSWD: /home/dom/.local/bin/claude, /bin/mkdir, /bin/rm"
  );
});

test("the sudoers line escapes characters sudoers would split on", () => {
  expect(sudoersLine("dom", "/opt/my tools/claude,v2")).toBe(
    "dom ALL=(hm-agent) CWD=* NOPASSWD: /opt/my\\ tools/claude\\,v2, /bin/mkdir, /bin/rm"
  );
});

test("the drop-in file ends with a newline and holds the one rule", () => {
  const file = sudoersFile("dom", "/usr/bin/claude");
  expect(file.endsWith("\n")).toBe(true);
  expect(file).toContain(
    "dom ALL=(hm-agent) CWD=* NOPASSWD: /usr/bin/claude, /bin/mkdir, /bin/rm\n"
  );
});

test("the drop-in path has no dot, which sudo would skip", () => {
  expect(sudoersPath("dom")).toBe("/etc/sudoers.d/harbourmaster-dom");
  expect(sudoersPath("john.doe")).toBe("/etc/sudoers.d/harbourmaster-john_doe");
});

test("resolveClaudeBinary keeps the path which finds, symlinks included", async () => {
  const run = fakeRun({ which: ok("/home/dom/.local/bin/claude\n") });
  expect(await resolveClaudeBinary(run)).toBe("/home/dom/.local/bin/claude");
});

test("resolveClaudeBinary is undefined when claude is not on the PATH", async () => {
  expect(await resolveClaudeBinary(fakeRun({}))).toBeUndefined();
});

test("resolveClaudeBinary is undefined for a relative answer", async () => {
  expect(
    await resolveClaudeBinary(fakeRun({ which: ok("bin/claude\n") }))
  ).toBeUndefined();
});

test("resolveClaudeBinary takes the override without looking at the PATH", async () => {
  const calls: string[][] = [];
  const run = fakeRun({}, calls);
  expect(await resolveClaudeBinary(run, "/x/claude")).toBe("/x/claude");
  expect(calls).toEqual([]);
});

test("canRunAsAgent runs the binary through sudo with no cached credentials", async () => {
  const calls: string[][] = [];
  const run = fakeRun({ sudo: ok("2.1.0\n") }, calls);
  expect(await canRunAsAgent(run, "/usr/bin/claude")).toBe(true);
  expect(calls).toEqual([
    ["sudo", "-k", "-n", "-u", "hm-agent", "/usr/bin/claude", "--version"],
  ]);
});

test("canRunAsAgent is false when sudo or the binary fails", async () => {
  expect(await canRunAsAgent(fakeRun({}), "/usr/bin/claude")).toBe(false);
});
