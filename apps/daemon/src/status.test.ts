import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "./command.ts";
import { type DaemonConfig, defaultConfigPath, writeConfig } from "./config.ts";
import { EXIT_FAILURE, EXIT_OK } from "./exit-codes.ts";
import { collectingLogger } from "./log.ts";
import { statusCommand } from "./status.ts";

const CONFIG: DaemonConfig = {
  claudeBinary: "/usr/bin/claude",
  credential: "hm_mach_secret-value",
  machineId: "01HZ0000000000000000000000",
  server: "https://hm.example.com",
  singleUser: false,
};

const ok = (stdout = ""): CommandResult => ({
  exitCode: 0,
  stderr: "",
  stdout,
});
const failed: CommandResult = { exitCode: 1, stderr: "no", stdout: "" };

/** A runner that answers from `answers` by the command's joined words. */
const fakeRun =
  (answers: Record<string, CommandResult>): CommandRunner =>
  (command) =>
    Promise.resolve(answers[command.join(" ")] ?? failed);

const CAT = "systemctl --user cat agentum";
const IS_ACTIVE = "systemctl --user is-active agentum";

let home = "";
let path = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hm-status-"));
  path = defaultConfigPath(home);
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

test("prints the machine, server, single_user and claude lines, never the credential", async () => {
  writeConfig(CONFIG, path);
  const lines: string[] = [];
  const code = await statusCommand({
    configPath: path,
    log: collectingLogger(lines),
    run: fakeRun({}),
  });
  expect(code).toBe(EXIT_OK);
  expect(lines).toContain(`machine: ${CONFIG.machineId}`);
  expect(lines).toContain(`server: ${CONFIG.server}`);
  expect(lines).toContain("single_user: false");
  expect(lines).toContain("claude: /usr/bin/claude");
  expect(lines.join("\n")).not.toContain(CONFIG.credential);
});

test("reports claude as not found when the config has no binary", async () => {
  writeConfig({ ...CONFIG, claudeBinary: null }, path);
  const lines: string[] = [];
  await statusCommand({
    configPath: path,
    log: collectingLogger(lines),
    run: fakeRun({}),
  });
  expect(lines).toContain("claude: not found");
});

test("reports the service as not installed when systemctl cat fails", async () => {
  writeConfig(CONFIG, path);
  const lines: string[] = [];
  await statusCommand({
    configPath: path,
    log: collectingLogger(lines),
    run: fakeRun({ [CAT]: failed }),
  });
  expect(lines).toContain("service: not installed");
});

test("reports the service state from is-active when installed", async () => {
  writeConfig(CONFIG, path);
  const lines: string[] = [];
  await statusCommand({
    configPath: path,
    log: collectingLogger(lines),
    run: fakeRun({ [CAT]: ok("[Unit]\n"), [IS_ACTIVE]: ok("active\n") }),
  });
  expect(lines).toContain("service: active");
});

test("reports the service as unknown when is-active prints nothing", async () => {
  writeConfig(CONFIG, path);
  const lines: string[] = [];
  await statusCommand({
    configPath: path,
    log: collectingLogger(lines),
    run: fakeRun({ [CAT]: ok("[Unit]\n"), [IS_ACTIVE]: ok("") }),
  });
  expect(lines).toContain("service: unknown");
});

test("a missing config returns 1 and says to enrol", async () => {
  const lines: string[] = [];
  const code = await statusCommand({
    configPath: path,
    log: collectingLogger(lines),
    run: fakeRun({}),
  });
  expect(code).toBe(EXIT_FAILURE);
  expect(lines.some((line) => line.includes("enroll"))).toBe(true);
});
