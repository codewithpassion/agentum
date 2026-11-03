#!/usr/bin/env bun
// Generates the new Worker's SECRETS_KEY and RUN_TOKEN_KEY
// (docs/v3/agentum-v2-cutover.md). The old values are lost, so the new Worker
// gets new ones, and the scrub in d1.ts clears what only the old ones could
// read. Usage, from apps/web, after `secrets.ts --apply` wrote the template:
//   bun scripts/migrate-v2/keys.ts --env staging|production [--apply]
// Without --apply it only checks the file. With --apply it writes both keys
// into .wrangler/migrate-v2/<new worker>.secrets.env, refusing to replace a
// value already there. It never prints a key.
import { file, write } from "bun";
import {
  fillSecrets,
  NAMES,
  newKey,
  parseMoveArgs,
  ROTATED,
} from "./helpers.ts";
import { WORK_DIR } from "./wrangler.ts";

const main = async () => {
  const { apply, env } = parseMoveArgs(process.argv.slice(2));
  const path = `${WORK_DIR}/${NAMES[env].newWorker}.secrets.env`;
  if (!(await file(path).exists())) {
    throw new Error(
      `${path} does not exist. Run secrets.ts --env ${env} --apply first.`
    );
  }
  const filled = fillSecrets(
    await file(path).text(),
    Object.fromEntries(ROTATED.map((name) => [name, newKey()]))
  );
  if (!apply) {
    console.log(`Dry run. --apply writes ${ROTATED.join(" and ")} to ${path}.`);
    return;
  }
  await write(path, filled);
  console.log(`Wrote new ${ROTATED.join(" and ")} to ${path}.`);
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "keys failed");
  process.exit(1);
}
