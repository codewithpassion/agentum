import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "./command.ts";
import { readConfig } from "./config.ts";
import { EXIT_FAILURE, EXIT_OK } from "./exit-codes.ts";
import { collectingLogger } from "./log.ts";
import { type MainDeps, main } from "./main.ts";
import { DAEMON_VERSION } from "./version.ts";

const CODE = "hm_enr_one-time-code";
const SERVER = "https://hm.example.com";

const failed: CommandResult = { exitCode: 1, stderr: "no", stdout: "" };

/** Every command fails, so the machine looks like it has no `claude`. */
const failingRun: CommandRunner = () => Promise.resolve(failed);

const neverSocket: MainDeps["wsFactory"] = () => {
  throw new Error("the tests must not open a socket");
};

/** A fetch that records its URLs and answers with a valid enrolment. */
const fakeFetch = (requested: string[]): typeof fetch => {
  const impl = (input: string | URL | Request) => {
    requested.push(String(input));
    return Promise.resolve(
      Response.json({ credential: "hm_mach_abc", machineId: "m1" })
    );
  };
  return Object.assign(impl, { preconnect: () => undefined }) as typeof fetch;
};

let dir: string;
let configPath: string;
let lines: string[];
let urls: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hm-main-"));
  configPath = join(dir, "config.json");
  lines = [];
  urls = [];
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const deps = (): Partial<MainDeps> => ({
  configPath,
  fetch: fakeFetch(urls),
  log: collectingLogger(lines),
  run: failingRun,
  wsFactory: neverSocket,
});

test("--version prints the daemon version and returns 0", async () => {
  expect(await main(["--version"], deps())).toBe(EXIT_OK);
  expect(lines).toEqual([DAEMON_VERSION]);
});

test("-v prints the daemon version and returns 0", async () => {
  expect(await main(["-v"], deps())).toBe(EXIT_OK);
  expect(lines).toEqual([DAEMON_VERSION]);
});

test("--help prints the usage and returns 0", async () => {
  expect(await main(["--help"], deps())).toBe(EXIT_OK);
  expect(lines.join("\n")).toContain("install-service");
});

test("-h prints the usage and returns 0", async () => {
  expect(await main(["-h"], deps())).toBe(EXIT_OK);
  expect(lines.join("\n")).toContain("enroll <code>");
});

test("no command prints the usage and returns 1", async () => {
  expect(await main([], deps())).toBe(EXIT_FAILURE);
  expect(lines.join("\n")).toContain("Usage:");
});

test("an unknown command is named and returns 1", async () => {
  expect(await main(["bogus"], deps())).toBe(EXIT_FAILURE);
  expect(lines.join("\n")).toContain("unknown command: bogus");
});

test("an unknown option returns 1", async () => {
  expect(await main(["status", "--nope"], deps())).toBe(EXIT_FAILURE);
  expect(urls).toEqual([]);
});

test("enroll without --server returns 1 and does not fetch", async () => {
  expect(await main(["enroll", CODE], deps())).toBe(EXIT_FAILURE);
  expect(urls).toEqual([]);
});

test("enroll without a code returns 1 and does not fetch", async () => {
  expect(await main(["enroll", "--server", SERVER], deps())).toBe(EXIT_FAILURE);
  expect(urls).toEqual([]);
});

test("enroll with a code and --server posts to the server and writes the config", async () => {
  const code = await main(["enroll", CODE, "--server", SERVER], deps());

  expect(code).toBe(EXIT_OK);
  expect(urls).toEqual([`${SERVER}/api/machines/enroll`]);
  const config = readConfig(configPath);
  expect(config.credential).toBe("hm_mach_abc");
  expect(config.machineId).toBe("m1");
  expect(config.server).toBe(SERVER);
});

test("run with no config returns 1 and says to enroll first", async () => {
  expect(await main(["run"], deps())).toBe(EXIT_FAILURE);
  expect(lines.join("\n")).toContain("enroll");
});

test("status with no config returns 1", async () => {
  expect(await main(["status"], deps())).toBe(EXIT_FAILURE);
});
