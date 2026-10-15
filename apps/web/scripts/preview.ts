#!/usr/bin/env bun
/// <reference types="bun" />
/**
 * Pull request previews (Cloudflare Worker Previews, open beta). Every PR gets
 * a preview of the staging Worker (`env.staging` in wrangler.jsonc) with its
 * own D1 database. The GitHub workflow calls this; you can too, from apps/web.
 *
 *   bun scripts/preview.ts deploy --name pr-42   # D1 + migrations + preview
 *   bun scripts/preview.ts delete --name pr-42   # preview + D1, idempotent
 *
 * `deploy` expects `bun run staging:build` to have run. The Vite plugin writes
 * the flattened staging config to dist/server/wrangler.json, and this script
 * patches the preview database into that file, never into wrangler.jsonc.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { file, spawnSync, write } from "bun";

export const DB_ID_PLACEHOLDER = "PREVIEW_DB_ID_PLACEHOLDER";
export const DB_NAME_PLACEHOLDER = "PREVIEW_DB_NAME_PLACEHOLDER";

const WRANGLER_ENV = "staging";
const APP_DIR = resolve(import.meta.dir, "..");
const MIGRATIONS_DIR = resolve(APP_DIR, "../../packages/db/migrations");
/** Written by the Cloudflare Vite plugin on build; points at the real config. */
const DEPLOY_REDIRECT = join(APP_DIR, ".wrangler/deploy/config.json");

const PREVIEW_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;
const WORKER_NAME = /"name":\s*"([^"]+)"/;
const LINE_BREAK = /\r?\n/;
const TRAILING_SLASH = /\/$/;

// Pure helpers, tested in preview.test.ts.

/** A preview name becomes part of a hostname, so keep it to one DNS label. */
export const assertPreviewName = (name: string): string => {
  if (!PREVIEW_NAME.test(name)) {
    throw new Error(
      `Invalid preview name ${JSON.stringify(name)}: use a-z, 0-9 and -, at most 41 characters.`
    );
  }
  return name;
};

/** The first `"name"` in wrangler.jsonc is the Worker name. */
export const workerName = (configText: string): string => {
  const name = configText.match(WORKER_NAME)?.[1];
  if (!name) {
    throw new Error('No "name" found in wrangler.jsonc.');
  }
  return name;
};

export const previewDbName = (worker: string, preview: string): string =>
  `${worker}-preview-${preview}`;

/**
 * Even with `--json`, wrangler prints banners and upload progress to stdout
 * ahead of the JSON body. Keep everything from the first line that opens an
 * object or an array.
 */
export const trimJsonNoise = (stdout: string): string => {
  const lines = stdout.split(LINE_BREAK);
  const start = lines.findIndex(
    (line) => line.startsWith("{") || line.startsWith("[")
  );
  if (start === -1) {
    throw new Error("No JSON found in wrangler output.");
  }
  return lines.slice(start).join("\n");
};

const firstUrl = (bag: unknown): string | null => {
  if (typeof bag !== "object" || bag === null || !("urls" in bag)) {
    return null;
  }
  const [first] = Array.isArray(bag.urls) ? bag.urls : [];
  return typeof first === "string" && first !== "" ? first : null;
};

/**
 * The docs show a top-level `preview_urls` array; wrangler 4.135 emitted
 * `{ preview: { urls }, deployment: { urls } }`. Handle both.
 */
export const extractPreviewUrl = (result: unknown): string | null => {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const flat =
    "preview_urls" in result ? firstUrl({ urls: result.preview_urls }) : null;
  const preview = "preview" in result ? firstUrl(result.preview) : null;
  const deployment =
    "deployment" in result ? firstUrl(result.deployment) : null;
  return (flat ?? preview ?? deployment)?.replace(TRAILING_SLASH, "") ?? null;
};

/** `wrangler d1 list --json` gives `[{ uuid, name, ... }]`. */
export const findDatabaseId = (
  listJson: string,
  name: string
): string | null => {
  const parsed: unknown = JSON.parse(trimJsonNoise(listJson));
  if (!Array.isArray(parsed)) {
    return null;
  }
  for (const row of parsed) {
    if (
      typeof row === "object" &&
      row !== null &&
      "name" in row &&
      row.name === name &&
      "uuid" in row &&
      typeof row.uuid === "string"
    ) {
      return row.uuid;
    }
  }
  return null;
};

export interface PreviewDb {
  databaseId: string;
  databaseName: string;
}

export const patchPreviewDb = (configText: string, db: PreviewDb): string => {
  if (!configText.includes(DB_ID_PLACEHOLDER)) {
    throw new Error(
      `${DB_ID_PLACEHOLDER} not found: the previews block is missing or already patched.`
    );
  }
  return configText
    .replaceAll(DB_ID_PLACEHOLDER, db.databaseId)
    .replaceAll(DB_NAME_PLACEHOLDER, db.databaseName);
};

// Side effects.

const log = (message: string) => console.warn(`[preview] ${message}`);

interface RunResult {
  status: number;
  stdout: string;
}

const wrangler = (args: string[], allowFailure = false): RunResult => {
  log(`$ wrangler ${args.join(" ")}`);
  // stdout captured for --json; stderr straight through for the CI log.
  const result = spawnSync(["bun", "x", "wrangler", ...args], {
    cwd: APP_DIR,
    stderr: "inherit",
    stdout: "pipe",
  });
  const stdout = result.stdout.toString();
  const status = result.exitCode ?? 1;
  if (status !== 0 && !allowFailure) {
    process.stdout.write(stdout);
    throw new Error(`wrangler ${args.join(" ")} exited with ${status}.`);
  }
  return { status, stdout };
};

const findOrCreateDatabase = (databaseName: string): PreviewDb => {
  const list = () => wrangler(["d1", "list", "--json"]).stdout;
  const existing = findDatabaseId(list(), databaseName);
  if (existing) {
    log(`reusing D1 ${databaseName} (${existing})`);
    return { databaseId: existing, databaseName };
  }
  // `d1 create` has no --json, so look the id up afterwards.
  wrangler(["d1", "create", databaseName]);
  const created = findDatabaseId(list(), databaseName);
  if (!created) {
    throw new Error(`Created D1 ${databaseName} but could not find its id.`);
  }
  log(`created D1 ${databaseName} (${created})`);
  return { databaseId: created, databaseName };
};

/**
 * `d1 migrations apply` only addresses databases listed in a config's
 * top-level `d1_databases`, and the preview database only exists inside the
 * `previews` block. So give it a throwaway config of its own.
 */
const applyMigrations = async (db: PreviewDb) => {
  const dir = mkdtempSync(join(tmpdir(), "preview-"));
  const config = join(dir, "wrangler.json");
  await write(
    config,
    JSON.stringify({
      compatibility_date: "2026-08-19",
      d1_databases: [
        {
          binding: "DB",
          database_id: db.databaseId,
          database_name: db.databaseName,
          migrations_dir: MIGRATIONS_DIR,
        },
      ],
      name: db.databaseName,
    })
  );
  try {
    wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", config]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

/** The config the staging build generated, which `wrangler preview` reads. */
const builtConfigPath = async (): Promise<string> => {
  const redirect = file(DEPLOY_REDIRECT);
  if (!(await redirect.exists())) {
    throw new Error(
      `${DEPLOY_REDIRECT} is missing. Run \`bun run staging:build\` first.`
    );
  }
  const { configPath } = (await redirect.json()) as { configPath: string };
  return resolve(APP_DIR, ".wrangler/deploy", configPath);
};

const setOutput = (key: string, value: string) => {
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    appendFileSync(output, `${key}=${value}\n`);
  }
};

const deploy = async (preview: string) => {
  const configPath = await builtConfigPath();
  const built = await file(configPath).text();
  const worker = workerName(await file(join(APP_DIR, "wrangler.jsonc")).text());

  const db = findOrCreateDatabase(previewDbName(worker, preview));
  // Every push: a new migration in the PR lands on its database here.
  await applyMigrations(db);
  await write(configPath, patchPreviewDb(built, db));

  const message = process.env.PREVIEW_MESSAGE;
  // --env staging alongside the build redirect: wrangler honours both, and
  // some preview subcommands target production without it.
  const result = wrangler([
    "preview",
    "--env",
    WRANGLER_ENV,
    "--name",
    preview,
    ...(message ? ["--message", message] : []),
    "--json",
  ]);
  const url = extractPreviewUrl(JSON.parse(trimJsonNoise(result.stdout)));
  if (!url) {
    throw new Error(
      "wrangler returned no preview URL. Has the staging Worker been deployed with preview_urls?"
    );
  }
  log(url);
  setOutput("url", url);
};

const remove = async (preview: string) => {
  const worker = workerName(await file(join(APP_DIR, "wrangler.jsonc")).text());
  // Tolerate "not found" on both, so closing a PR whose deploy failed
  // halfway, or closing it twice, still cleans up whatever is left.
  const previewDelete = wrangler(
    [
      "preview",
      "delete",
      "--env",
      WRANGLER_ENV,
      "--name",
      preview,
      "--skip-confirmation",
    ],
    true
  );
  if (previewDelete.status !== 0) {
    log(`preview ${preview} not deleted, continuing.`);
  }
  const databaseName = previewDbName(worker, preview);
  const dbDelete = wrangler(
    ["d1", "delete", databaseName, "--skip-confirmation"],
    true
  );
  if (dbDelete.status !== 0) {
    log(`D1 ${databaseName} not deleted, continuing.`);
  }
};

const main = async (argv: string[]) => {
  const [command] = argv;
  const nameIndex = argv.indexOf("--name");
  const name = nameIndex === -1 ? undefined : argv[nameIndex + 1];
  if (!name || (command !== "deploy" && command !== "delete")) {
    console.error("usage: bun scripts/preview.ts deploy|delete --name <name>");
    process.exit(1);
  }
  const preview = assertPreviewName(name);
  await (command === "deploy" ? deploy(preview) : remove(preview));
};

if (import.meta.main) {
  await main(process.argv.slice(2));
}
