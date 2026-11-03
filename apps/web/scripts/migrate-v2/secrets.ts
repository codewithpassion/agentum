#!/usr/bin/env bun
// Lists the old Worker's secret names and writes a `--secrets-file` template
// for the new one (docs/v3/agentum-v2-cutover.md). Names only: Cloudflare never
// returns a secret's value, so the values come from wherever Dom keeps them.
// SECRETS_KEY and RUN_TOKEN_KEY get new values from keys.ts instead.
// Usage, from apps/web:
//   bun scripts/migrate-v2/secrets.ts --env staging|production [--apply]
// Without --apply it prints the names. With --apply it also writes the template
// to .wrangler/migrate-v2/<new worker>.secrets.env, refusing to overwrite one.
import { mkdir } from "node:fs/promises";
import { file, write } from "bun";
import {
  KEEP_VALUE,
  NAMES,
  parseMoveArgs,
  parseSecretNames,
  ROTATED,
  secretsTemplate,
} from "./helpers.ts";
import { WORK_DIR, wrangler } from "./wrangler.ts";

const main = async () => {
  const { apply, env } = parseMoveArgs(process.argv.slice(2));
  const { oldWorker, newWorker } = NAMES[env];
  const secretNames = parseSecretNames(
    await wrangler(["secret", "list", "--name", oldWorker, "--format", "json"])
  );
  console.log(`${oldWorker} has ${secretNames.length} secrets:`);
  const note = (name: string) => {
    if (KEEP_VALUE.has(name)) {
      return "  (same value, required)";
    }
    return (ROTATED as readonly string[]).includes(name)
      ? "  (new value, from keys.ts)"
      : "";
  };
  for (const name of secretNames) {
    console.log(`  ${name}${note(name)}`);
  }
  if (!apply) {
    console.log("Dry run. --apply writes the --secrets-file template.");
    return;
  }
  await mkdir(WORK_DIR, { recursive: true });
  const path = `${WORK_DIR}/${newWorker}.secrets.env`;
  if (await file(path).exists()) {
    throw new Error(
      `${path} exists already; it may hold values. Not touching it.`
    );
  }
  await write(path, secretsTemplate(secretNames, oldWorker));
  console.log(
    `Wrote ${path}. Fill in the values, then deploy with --secrets-file ${path}.`
  );
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "secrets failed");
  process.exit(1);
}
