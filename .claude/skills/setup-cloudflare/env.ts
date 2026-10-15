#!/usr/bin/env bun
/**
 * Edits apps/web config for the setup-cloudflare skill without printing a
 * secret. Commands:
 *
 *   account <id>       set CLOUDFLARE_ACCOUNT_ID in .env.local (wrangler reads
 *                      it from there)
 *   database <uuid>    set the D1 binding's database_id in wrangler.jsonc
 *   secrets-file       write the keys the deployed Worker needs to a temp file
 *                      for `wrangler deploy --secrets-file`, and print its path
 */
import { tmpdir } from "node:os";
import { $, file, write } from "bun";

// Empty by design: nothing the boilerplate puts in .env.local belongs on a
// deployed Worker. CLOUDFLARE_ACCOUNT_ID is for wrangler itself. A skill that
// adds a service the Worker reads keys from (add-clerk) adds those key names here.
const DEPLOYED_KEYS: readonly string[] = [];

const DATABASE_ID = /("database_id":\s*)"[^"]*"/;

const root = (await $`git rev-parse --show-toplevel`.text()).trim();
const envPath = `${root}/apps/web/.env.local`;

const usage = () => {
  console.error(
    "usage: bun .claude/skills/setup-cloudflare/env.ts account <id> | database <uuid> | secrets-file"
  );
  process.exit(1);
};

/** The .env.local text, or an exit if the file is not there yet. */
const readEnv = async (): Promise<string> => {
  const envFile = file(envPath);
  if (await envFile.exists()) {
    return await envFile.text();
  }
  console.error(`${envPath} does not exist. Copy apps/web/.env.example first.`);
  return process.exit(1);
};

const [, , command, argument] = process.argv;

if (command === "account" && argument) {
  const text = await readEnv();
  const line = `CLOUDFLARE_ACCOUNT_ID=${argument}`;
  const existing = /^CLOUDFLARE_ACCOUNT_ID=.*$/m;
  await write(
    envPath,
    existing.test(text)
      ? text.replace(existing, line)
      : `${text.trimEnd()}\n${line}\n`
  );
  console.log(line);
} else if (command === "database" && argument) {
  const configPath = `${root}/apps/web/wrangler.jsonc`;
  const text = await file(configPath).text();
  if (!DATABASE_ID.test(text)) {
    console.error(`No "database_id" found in ${configPath}.`);
    process.exit(1);
  }
  await write(configPath, text.replace(DATABASE_ID, `$1"${argument}"`));
  console.log(`database_id=${argument}`);
} else if (command === "secrets-file") {
  const text = await readEnv();
  const get = (key: string): string =>
    text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1].trim() ?? "";
  const present = DEPLOYED_KEYS.filter((key) => get(key) !== "");
  if (present.length === 0) {
    console.log("Nothing to upload: deploy without --secrets-file.");
    process.exit(0);
  }
  const path = `${tmpdir()}/worker-secrets-${crypto.randomUUID()}.env`;
  await write(
    path,
    `${present.map((key) => `${key}=${get(key)}`).join("\n")}\n`
  );
  console.log(`${path}\n${present.join("\n")}`);
} else {
  usage();
}
