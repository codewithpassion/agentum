import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DaemonConfig,
  defaultConfigPath,
  readConfig,
  writeConfig,
} from "./config.ts";

const CONFIG: DaemonConfig = {
  claudeBinary: "/usr/bin/claude",
  credential: "hm_mach_secret-value",
  machineId: "01HZ0000000000000000000000",
  server: "https://hm.example.com",
  singleUser: false,
};

/** The permission bits as an octal string, such as "600". */
const modeOf = (path: string): string =>
  statSync(path).mode.toString(8).slice(-3);

let home = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hm-config-"));
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

test("the default path is ~/.harbourmaster/config.json", () => {
  expect(defaultConfigPath("/home/dom")).toBe(
    "/home/dom/.harbourmaster/config.json"
  );
});

test("a written config reads back the same", () => {
  const path = defaultConfigPath(home);
  writeConfig(CONFIG, path);
  expect(readConfig(path)).toEqual(CONFIG);
});

test("the file is mode 600 and the directory mode 700", () => {
  const path = defaultConfigPath(home);
  writeConfig(CONFIG, path);
  expect(modeOf(path)).toBe("600");
  expect(modeOf(join(home, ".harbourmaster"))).toBe("700");
});

test("writing tightens a directory and file that were wider", () => {
  const path = defaultConfigPath(home);
  writeConfig(CONFIG, path);
  chmodSync(path, 0o644);
  chmodSync(join(home, ".harbourmaster"), 0o755);
  writeConfig(CONFIG, path);
  expect(modeOf(path)).toBe("600");
  expect(modeOf(join(home, ".harbourmaster"))).toBe("700");
});

test("a missing file says to enrol", () => {
  expect(() => readConfig(defaultConfigPath(home))).toThrow("enroll");
});

test("an unusable file names the field and never the credential", () => {
  const path = defaultConfigPath(home);
  writeConfig(CONFIG, path);
  writeFileSync(path, JSON.stringify({ ...CONFIG, singleUser: "yes" }));
  let message = "";
  try {
    readConfig(path);
  } catch (error) {
    message = error instanceof Error ? error.message : "";
  }
  expect(message).toContain("singleUser");
  expect(message).not.toContain("hm_mach_secret-value");
});

test("invalid JSON does not echo the file", () => {
  const path = defaultConfigPath(home);
  writeConfig(CONFIG, path);
  writeFileSync(path, "{ hm_mach_secret-value");
  expect(() => readConfig(path)).toThrow("not valid JSON");
});
