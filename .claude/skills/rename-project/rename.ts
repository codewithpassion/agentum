#!/usr/bin/env bun
/**
 * Renames this monorepo. Rewrites the project name in the places that carry it
 * as structured data, then reports every other mention for a human to judge.
 * Prose like "without creating API boilerplate" must not be rewritten.
 */
import { $, file, Glob, write } from "bun";

const WORKER_NAME = /^[a-z0-9][a-z0-9-]*$/;

const [, , newName] = process.argv;
if (!newName) {
  console.error(
    "usage: bun .claude/skills/rename-project/rename.ts <new-name>"
  );
  process.exit(1);
}
if (!WORKER_NAME.test(newName)) {
  console.error(
    `"${newName}" is not a valid Cloudflare Worker name: lowercase letters, digits and hyphens, starting with a letter or digit.`
  );
  process.exit(1);
}

const root = (await $`git rev-parse --show-toplevel`.text()).trim();
const oldName = JSON.parse(await file(`${root}/package.json`).text())
  .name as string;

if (oldName === newName) {
  console.log(`Already named "${newName}". Nothing to do.`);
  process.exit(0);
}

const title = (slug: string) =>
  slug
    .split("-")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");

const oldTitle = title(oldName);
const newTitle = title(newName);

/** One file, one regex, one replacement. Reports a miss instead of failing. */
interface Rewrite {
  file: string;
  find: RegExp;
  to: string;
  what: string;
}

const appFiles = async (pattern: string) => {
  const found: string[] = [];
  for await (const path of new Glob(pattern).scan({ cwd: root })) {
    found.push(path);
  }
  return found;
};

// `"name":` needs the quote in front, so this does not also hit
// `"database_name":`, which gets its own rewrite below.
const nameField = new RegExp(`("name":\\s*)"${oldName}"`);
const heading = new RegExp(`^# ${oldTitle}$`, "m");
// Also the staging database (`<name>-staging`); preview database names are
// derived from the Worker name at deploy time.
const databaseNameField = new RegExp(
  `("database_name":\\s*)"${oldName}(-staging)?"`,
  "g"
);

const rewrites: Rewrite[] = [
  {
    file: "package.json",
    find: nameField,
    to: `$1"${newName}"`,
    what: "workspace name",
  },
  {
    // Only the root workspace entry -- a dependency could share the name.
    file: "bun.lock",
    find: nameField,
    to: `$1"${newName}"`,
    what: "lockfile workspace name",
  },
  { file: "README.md", find: heading, to: `# ${newTitle}`, what: "heading" },
];

for (const path of await appFiles("apps/*/wrangler.jsonc")) {
  rewrites.push({
    file: path,
    find: nameField,
    to: `$1"${newName}"`,
    what: "Worker name",
  });
  rewrites.push({
    file: path,
    find: databaseNameField,
    to: `$1"${newName}$2"`,
    what: "D1 database name",
  });
}
for (const path of await appFiles("apps/*/.cta.json")) {
  rewrites.push({
    file: path,
    find: new RegExp(`("projectName":\\s*)"${oldName}"`),
    to: `$1"${newName}"`,
    what: "projectName",
  });
}
for (const path of await appFiles("apps/*/README.md")) {
  rewrites.push({
    file: path,
    find: heading,
    to: `# ${newTitle}`,
    what: "heading",
  });
}
for (const path of await appFiles("apps/*/src/routes/__root.tsx")) {
  rewrites.push({
    file: path,
    // The scaffold ships a placeholder title, so match any title, not the old name.
    find: /(title:\s*)"[^"]*"/,
    to: `$1"${newTitle}"`,
    what: "browser tab title",
  });
}

/** Every rewrite for one file, in one read and one write. */
const apply = async (path: string, forFile: Rewrite[]) => {
  const handle = file(`${root}/${path}`);
  if (!(await handle.exists())) {
    return [];
  }
  const before = await handle.text();
  let text = before;
  const results: { changed: boolean; label: string }[] = [];
  for (const { find, to, what } of forFile) {
    const after = text.replace(find, to);
    results.push({ changed: after !== text, label: `${path} (${what})` });
    text = after;
  }
  if (text !== before) {
    await write(handle, text);
  }
  return results;
};

// Grouped by file, because wrangler.jsonc carries both the Worker name and the
// D1 database name and the two rewrites must not race each other.
const byFile = new Map<string, Rewrite[]>();
for (const rewrite of rewrites) {
  const forFile = byFile.get(rewrite.file) ?? [];
  forFile.push(rewrite);
  byFile.set(rewrite.file, forFile);
}

const grouped = await Promise.all(
  [...byFile].map(([path, forFile]) => apply(path, forFile))
);

console.log(`Renamed "${oldName}" -> "${newName}"\n`);
for (const result of grouped.flat()) {
  console.log(
    `  ${result.changed ? "updated  " : "unchanged"} ${result.label}`
  );
}

const remaining = await $`git grep -rin ${oldName} -- . ':!bun.lock'`
  .nothrow()
  .text();
if (remaining.trim()) {
  console.log("\nStill mentions the old name. Review each by hand:\n");
  console.log(remaining.trim());
}

const install = await $`bun install --frozen-lockfile`.nothrow().quiet();
console.log(
  install.exitCode === 0
    ? "\nbun install --frozen-lockfile: lockfile is in sync."
    : "\nbun install --frozen-lockfile FAILED. The lockfile name may not have been rewritten."
);
