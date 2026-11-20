import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOM_DIR = dirname(fileURLToPath(import.meta.url));
const ROOM_ALIAS = "#/components/agent/room/";
const SOURCE_FILE = /\.tsx?$/;

/**
 * Folder pairs that may import across. The Right now panel (`now/`) is hosted
 * by the Chat and Work tabs and shows Learned this week from `knows/`, as the
 * RH.5 log allows. Everything else shared lives beside the tabs in `room/`.
 */
const ALLOWED = new Set(["chat>now", "work>now", "now>knows"]);

/** The folder directly under `room/` a path sits in, or null for a file in `room/` itself. */
const folderOf = (path: string): string | null => {
  const parts = relative(ROOM_DIR, path).split(sep);
  return parts.length > 1 ? (parts[0] ?? null) : null;
};

/** The folder an import lands in. A bare `../settings` names a tab folder itself. */
const targetFolderOf = (target: string): string | null => {
  const folder = folderOf(target);
  if (folder !== null) {
    return folder;
  }
  const [first, ...rest] = relative(ROOM_DIR, target).split(sep);
  const isTabFolder =
    first !== undefined &&
    rest.length === 0 &&
    statSync(target, { throwIfNoEntry: false })?.isDirectory() === true;
  return isTabFolder ? first : null;
};

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return SOURCE_FILE.test(entry.name) ? [path] : [];
  });

const targetOf = (from: string, specifier: string): string | null => {
  if (specifier.startsWith(ROOM_ALIAS)) {
    return resolve(ROOM_DIR, specifier.slice(ROOM_ALIAS.length));
  }
  if (specifier.startsWith(".")) {
    return resolve(dirname(from), specifier);
  }
  return null;
};

const crossFolderImports = (): { edge: string; label: string }[] => {
  const found: { edge: string; label: string }[] = [];
  for (const path of sourceFiles(ROOM_DIR)) {
    const from = folderOf(path);
    if (from === null) {
      continue;
    }
    const { importedFiles } = ts.preProcessFile(
      readFileSync(path, "utf8"),
      true,
      true
    );
    for (const { fileName } of importedFiles) {
      const target = targetOf(path, fileName);
      const to = target === null ? null : targetFolderOf(target);
      if (to !== null && to !== from) {
        found.push({
          edge: `${from}>${to}`,
          label: `${relative(ROOM_DIR, path)} imports ${fileName}`,
        });
      }
    }
  }
  return found;
};

test("no room tab imports from another tab's folder", () => {
  const imports = crossFolderImports();
  // The scan sees the imports it is meant to allow, so an empty result is not a parse failure.
  expect(new Set(imports.map(({ edge }) => edge))).toEqual(ALLOWED);
  expect(
    imports.filter(({ edge }) => !ALLOWED.has(edge)).map(({ label }) => label)
  ).toEqual([]);
});
