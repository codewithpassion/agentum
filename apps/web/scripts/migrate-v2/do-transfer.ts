#!/usr/bin/env bun
// Prepares the first deploy of agentum-v2 or agentum-v2-staging, the one that
// takes the old Worker's Durable Object namespaces
// (docs/v3/agentum-v2-cutover.md). It patches the built
// dist/server/wrangler.json: the `exports` map goes and a legacy
// `transferred_classes` migration (tag v10) moves every class from
// harbourmaster or harbourmaster-staging. Dry run unless --apply. Usage, from
// apps/web, after `bun run build` or `bun run staging:build`:
//   bun scripts/migrate-v2/do-transfer.ts [--apply]
// then deploy that file with `bunx wrangler deploy -c dist/server/wrangler.json`
// and no rebuild in between. It refuses when the target Worker already exists:
// a Worker that has been deployed without the transfer owns empty namespaces
// under the same class names, and the transfer would fail on them.
import { join } from "node:path";
import { file, write } from "bun";
import { envOfWorker, NAMES, transferConfig } from "./helpers.ts";
import { wrangler } from "./wrangler.ts";

const MISSING_WORKER = /does not exist|code: 10007/i;
const BUILT = join(import.meta.dir, "../../dist/server/wrangler.json");

const workerExists = async (name: string): Promise<boolean> => {
  try {
    await wrangler(["deployments", "list", "--name", name]);
    return true;
  } catch (error) {
    const text = error instanceof Error ? error.message : "";
    if (MISSING_WORKER.test(text)) {
      return false;
    }
    throw error;
  }
};

const main = async () => {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  if (argv.some((arg) => arg !== "--apply")) {
    throw new Error("The only flag is --apply.");
  }
  if (!(await file(BUILT).exists())) {
    throw new Error(`${BUILT} is missing. Build first.`);
  }
  const built = (await file(BUILT).json()) as Record<string, unknown>;
  const env = envOfWorker(built.name);
  const { newWorker, oldWorker } = NAMES[env];
  if (await workerExists(newWorker)) {
    throw new Error(
      `${newWorker} exists already. Check its Durable Object namespaces before going on (cutover runbook, "If the new Worker exists").`
    );
  }
  const patched = transferConfig(built);
  console.log(
    `${newWorker} does not exist yet. Its first deploy will transfer every Durable Object class from ${oldWorker}:`
  );
  console.log(JSON.stringify(patched.migrations, null, 2));
  if (!apply) {
    console.log("Dry run. --apply writes the patched config.");
    return;
  }
  await write(BUILT, `${JSON.stringify(patched, null, 2)}\n`);
  console.log(
    `Patched ${BUILT}. Deploy it now: bunx wrangler deploy -c dist/server/wrangler.json`
  );
};

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "do-transfer failed");
  process.exit(1);
}
