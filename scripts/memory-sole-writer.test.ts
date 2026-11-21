import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SOURCES = ["packages", "apps"];
// The library defines `writeMemoryFiles`; the memory service's file module is the one caller.
const ALLOWED = [
  "packages/services/src/library.ts",
  "packages/services/src/memory/files.ts",
];
const IN_SRC = /(^|\/)src\/.*\.tsx?$/;
const SKIPPED = /node_modules|\.test\.|test-world/;

const sourceFiles = async (source: string): Promise<string[]> =>
  (await readdir(resolve(ROOT, source), { recursive: true }))
    .filter((path) => IN_SRC.test(path) && !SKIPPED.test(path))
    .map((path) => resolve(ROOT, source, path));

// Reads every source file, which outlasts bun's 5s default on a loaded machine.
const SOURCE_SCAN_TIMEOUT_MS = 60_000;

test(
  "only the memory service calls the library's memory write",
  async () => {
    const files = (await Promise.all(SOURCES.map(sourceFiles))).flat();
    const texts = await Promise.all(
      files.map((file) => readFile(file, "utf8"))
    );
    const users = files
      .filter((_, index) => texts[index]?.includes("writeMemoryFiles"))
      .map((file) => relative(ROOT, file));

    expect(users.sort()).toEqual(ALLOWED);
  },
  SOURCE_SCAN_TIMEOUT_MS
);
