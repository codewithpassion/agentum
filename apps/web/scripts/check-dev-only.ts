#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * Production build guard. Dev builds register the dev-only slow read and
 * gated tools (src/server/pi-run-dev-tools.ts). A production build must not
 * contain them, so this script fails the build when a built server file
 * mentions a tool's name or its storage key.
 *
 *   bun scripts/check-dev-only.ts   # after `vite build`, reads dist/server
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  GATED_COUNT_KEY,
  GATED_TOOL,
  SLOW_READ_COUNT_KEY,
  SLOW_READ_TOOL,
} from "../src/server/pi-run-dev-tools.ts";

const APP_DIR = resolve(import.meta.dir, "..");
const SERVER_DIR = join(APP_DIR, "dist/server");
const TEXT_FILE = /\.(js|mjs|json)$/;
const MARKERS = [
  SLOW_READ_TOOL,
  SLOW_READ_COUNT_KEY,
  GATED_TOOL,
  GATED_COUNT_KEY,
];

/** The paths of the files whose text contains a dev-only marker. */
export const findDevOnly = (
  files: { path: string; text: string }[]
): string[] =>
  files
    .filter((file) => MARKERS.some((marker) => file.text.includes(marker)))
    .map((file) => file.path);

const listFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const found = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
    })
  );
  return found.flat();
};

const main = async () => {
  if (!existsSync(SERVER_DIR)) {
    console.error(
      `check-dev-only: ${SERVER_DIR} is missing. Run the build first.`
    );
    process.exit(1);
  }
  const paths = (await listFiles(SERVER_DIR)).filter((path) =>
    TEXT_FILE.test(path)
  );
  const files = await Promise.all(
    paths.map(async (path) => ({
      path: relative(APP_DIR, path),
      text: await readFile(path, "utf8"),
    }))
  );
  const offenders = findDevOnly(files);
  if (offenders.length > 0) {
    console.error(
      `check-dev-only: dev-only tool code in production build: ${offenders.join(", ")}`
    );
    process.exit(1);
  }
  console.log(`check-dev-only: ok, ${files.length} server files checked`);
};

if (import.meta.main) {
  await main();
}
