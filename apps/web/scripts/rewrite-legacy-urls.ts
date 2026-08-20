#!/usr/bin/env bun
// Phase 3 moved every resource route under `/api/w/:slug`, but content written
// before that carries absolute `/api/…` URLs *inside its markdown* - wiki asset
// images and the odd screenshot link pasted into a message. Those now 404.
//
// All of it belongs to the workspace migration 0012 created, so the fix is a
// one-shot rewrite of the stored text rather than a rule in the renderer: the
// URLs are data, they were wrong the moment the routes moved, and a render-time
// patch would have to stay forever and would still leave the database lying.
//
// Idempotent: a URL already under `/api/w/` is left alone.
//
//   bun run rewrite-legacy-urls      (from apps/web)
import { DEFAULT_WORKSPACE_ID } from "#/modules/workspaces/service";
import { d1Execute, requireDefaultWorkspace, sqlValue } from "./d1";

/** The routers that moved. `health`, `dev-login` and `workspaces` did not. */
const MOVED = [
  "agents",
  "attachments",
  "bridges",
  "categories",
  "channels",
  "connectors",
  "messages",
  "skills",
  "wiki",
];

const LEGACY_URL = new RegExp(`/api/(?=(?:${MOVED.join("|")})/)`, "g");

/** Every column that holds markdown somebody or some agent wrote. */
const COLUMNS = [
  { column: "body", table: "messages" },
  { column: "body", table: "wiki_pages" },
  { column: "body", table: "wiki_revisions" },
];

await requireDefaultWorkspace();

const [workspace] = await d1Execute<{ slug: string }>(
  `SELECT slug FROM workspaces WHERE id = ${sqlValue(DEFAULT_WORKSPACE_ID)}`
);

if (!workspace) {
  throw new Error("No default workspace to rewrite legacy URLs into.");
}

const prefix = `/api/w/${workspace.slug}/`;
let rewritten = 0;

for (const { column, table } of COLUMNS) {
  // biome-ignore lint/performance/noAwaitInLoops: a one-shot script over three small tables
  const rows = await d1Execute<{ id: string; text: string | null }>(
    `SELECT id, ${column} AS text FROM ${table}`
  );

  for (const row of rows) {
    // `String.replace` with a global regex always starts from the beginning,
    // so nothing here depends on the regex's `lastIndex`.
    const next = row.text?.replace(LEGACY_URL, prefix);
    if (next === undefined || next === row.text) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one statement at a time, on purpose
    await d1Execute(
      `UPDATE ${table} SET ${column} = ${sqlValue(next)} WHERE id = ${sqlValue(row.id)}`
    );
    rewritten += 1;
    console.log(`Rewrote ${table}.${row.id}`);
  }
}

console.log(
  rewritten === 0
    ? "No legacy /api URLs left in stored content."
    : `Rewrote ${rewritten} row(s) into ${prefix}.`
);
