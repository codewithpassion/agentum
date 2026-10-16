import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "./command.ts";
import { defaultConfigPath, readConfig } from "./config.ts";
import { enrollCommand } from "./enroll.ts";
import { EXIT_FAILURE, EXIT_OK } from "./exit-codes.ts";
import { collectingLogger } from "./log.ts";

const CODE = "hm_enr_one-time-code";
const CREDENTIAL = "hm_mach_secret-value";
const MACHINE_ID = "01HZ0000000000000000000000";
const SERVER = "https://hm.example.com";
const CLAUDE = "/usr/bin/claude";
const PERMISSION_BITS = 0o777;

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

/** Claude on the PATH and hm-agent able to run it. */
const claudeAndAgent: Record<string, CommandResult> = {
  sudo: ok(`${CLAUDE}\n`),
  which: ok(`${CLAUDE}\n`),
};

interface RecordedRequest {
  body: unknown;
  headers: unknown;
  method: string | undefined;
  url: string;
}

/**
 * A fetch that records each request and answers with `respond`. A rejected
 * promise from `respond` becomes a rejected fetch, as a network failure does.
 */
const fakeFetch = (
  respond: () => Response | Promise<Response>,
  requests: RecordedRequest[] = []
): typeof fetch => {
  const impl = (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      body: JSON.parse(String(init?.body)),
      headers: init?.headers,
      method: init?.method,
      url: String(input),
    });
    return Promise.resolve(respond());
  };
  return Object.assign(impl, { preconnect: () => undefined }) as typeof fetch;
};

const enrolResponse = (): Response =>
  Response.json({ credential: CREDENTIAL, machineId: MACHINE_ID });

let home = "";
let configPath = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hm-enroll-"));
  configPath = defaultConfigPath(home);
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

test("enrols, posts the code and writes the config at mode 600", async () => {
  const lines: string[] = [];
  const requests: RecordedRequest[] = [];

  const code = await enrollCommand({
    code: CODE,
    configPath,
    fetch: fakeFetch(enrolResponse, requests),
    log: collectingLogger(lines),
    run: fakeRun(claudeAndAgent),
    server: `${SERVER}/`,
  });

  expect(code).toBe(EXIT_OK);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(`${SERVER}/api/machines/enroll`);
  expect(requests[0]?.method).toBe("POST");
  expect(requests[0]?.body).toEqual({ code: CODE, singleUser: false });
  expect(readConfig(configPath)).toEqual({
    claudeBinary: CLAUDE,
    credential: CREDENTIAL,
    machineId: MACHINE_ID,
    server: SERVER,
    singleUser: false,
  });
  // biome-ignore lint/suspicious/noBitwiseOperators: masking the permission bits out of a stat mode.
  expect(statSync(configPath).mode & PERMISSION_BITS).toBe(0o600);
  expect(lines.join("\n")).toContain(MACHINE_ID);
  expect(lines.join("\n")).not.toContain(CREDENTIAL);
  expect(lines.join("\n")).not.toContain(CODE);
});

test("single_user is false when claude resolves and hm-agent can run it", async () => {
  const requests: RecordedRequest[] = [];
  const lines: string[] = [];

  await enrollCommand({
    code: CODE,
    configPath,
    fetch: fakeFetch(enrolResponse, requests),
    log: collectingLogger(lines),
    run: fakeRun(claudeAndAgent),
    server: SERVER,
  });

  expect(requests[0]?.body).toEqual({ code: CODE, singleUser: false });
  expect(readConfig(configPath).singleUser).toBe(false);
  expect(readConfig(configPath).claudeBinary).toBe(CLAUDE);
  expect(lines.join("\n")).not.toContain("single_user is true");
});

test("single_user is true when the sudo probe fails", async () => {
  const requests: RecordedRequest[] = [];
  const lines: string[] = [];

  const code = await enrollCommand({
    code: CODE,
    configPath,
    fetch: fakeFetch(enrolResponse, requests),
    log: collectingLogger(lines),
    run: fakeRun({ which: ok(`${CLAUDE}\n`) }),
    server: SERVER,
  });

  expect(code).toBe(EXIT_OK);
  expect(requests[0]?.body).toEqual({ code: CODE, singleUser: true });
  expect(readConfig(configPath).singleUser).toBe(true);
  expect(readConfig(configPath).claudeBinary).toBe(CLAUDE);
  expect(lines.join("\n")).toContain("install-service");
});

test("single_user is true and claudeBinary null when claude is not found", async () => {
  const requests: RecordedRequest[] = [];
  const lines: string[] = [];

  const code = await enrollCommand({
    code: CODE,
    configPath,
    fetch: fakeFetch(enrolResponse, requests),
    log: collectingLogger(lines),
    run: fakeRun({}),
    server: SERVER,
  });

  expect(code).toBe(EXIT_OK);
  expect(requests[0]?.body).toEqual({ code: CODE, singleUser: true });
  expect(readConfig(configPath).singleUser).toBe(true);
  expect(readConfig(configPath).claudeBinary).toBeNull();
  expect(lines.join("\n")).toContain("no claude binary was found");
});

test("a 401 logs the status and the server's message and writes no config", async () => {
  const lines: string[] = [];

  const code = await enrollCommand({
    code: CODE,
    configPath,
    fetch: fakeFetch(() =>
      Response.json({ error: "enrolment code expired" }, { status: 401 })
    ),
    log: collectingLogger(lines),
    run: fakeRun(claudeAndAgent),
    server: SERVER,
  });

  expect(code).toBe(EXIT_FAILURE);
  expect(lines.join("\n")).toContain("401");
  expect(lines.join("\n")).toContain("enrolment code expired");
  expect(existsSync(configPath)).toBe(false);
});

test("a thrown fetch returns 1 and writes no config", async () => {
  const lines: string[] = [];

  const code = await enrollCommand({
    code: CODE,
    configPath,
    fetch: fakeFetch(() => Promise.reject(new TypeError("fetch failed"))),
    log: collectingLogger(lines),
    run: fakeRun(claudeAndAgent),
    server: SERVER,
  });

  expect(code).toBe(EXIT_FAILURE);
  expect(lines.join("\n")).toContain("fetch failed");
  expect(existsSync(configPath)).toBe(false);
});

test("an answer that is not an enrolment response returns 1 and writes no config", async () => {
  const lines: string[] = [];

  const code = await enrollCommand({
    code: CODE,
    configPath,
    fetch: fakeFetch(() => Response.json({ credential: "not-a-credential" })),
    log: collectingLogger(lines),
    run: fakeRun(claudeAndAgent),
    server: SERVER,
  });

  expect(code).toBe(EXIT_FAILURE);
  expect(existsSync(configPath)).toBe(false);
  expect(lines.join("\n")).not.toContain("not-a-credential");
});

test("a server that is not a URL returns 1 without calling it", async () => {
  const requests: RecordedRequest[] = [];

  const code = await enrollCommand({
    code: CODE,
    configPath,
    fetch: fakeFetch(enrolResponse, requests),
    log: collectingLogger([]),
    run: fakeRun(claudeAndAgent),
    server: "not a url",
  });

  expect(code).toBe(EXIT_FAILURE);
  expect(requests).toHaveLength(0);
  expect(existsSync(configPath)).toBe(false);
});
