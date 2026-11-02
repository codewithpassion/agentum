#!/usr/bin/env bun
// Makes the workspace row that admits a Clerk organisation. It is how the
// first workspace of a deployment gets made, since nobody there is an admin yet.
// Checks that the organisation exists on the Clerk instance for that
// environment, then inserts through `wrangler d1 execute`. Safe to run twice.
// Usage, from apps/web:
//   bun run add-workspace --org <id> --name <name> (--local | --remote [--env staging])
import { createClerkClient } from "@clerk/backend";
import { isClerkAPIResponseError } from "@clerk/backend/errors";
import { file, spawn } from "bun";
import { ulid } from "ulidx";
import {
  clerkEnvFor,
  insertSql,
  parseArgs,
  selectSql,
  wranglerTarget,
} from "./add-workspace-helpers.ts";
import { parseEnvFile, resolveSecretKey } from "./agent-login-helpers.ts";

const WEB_DIR = `${import.meta.dir}/..`;

const readEnvFile = async (name: string): Promise<Record<string, string>> => {
  const envFile = file(`${WEB_DIR}/${name}`);
  return (await envFile.exists()) ? parseEnvFile(await envFile.text()) : {};
};

const wrangler = async (args: string[]): Promise<string> => {
  const proc = spawn(["bunx", "wrangler", ...args], {
    cwd: WEB_DIR,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `wrangler ${args.slice(0, 3).join(" ")} failed:\n${out}${err}`
    );
  }
  return out;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const clerkEnv = clerkEnvFor(args);
  const secretKey = resolveSecretKey(clerkEnv, {
    envLocal: await readEnvFile(".env.local"),
    process: process.env,
    productionLocal: await readEnvFile(".env.production.local"),
  });

  const clerk = createClerkClient({ secretKey });
  try {
    await clerk.organizations.getOrganization({ organizationId: args.orgId });
  } catch (error) {
    if (isClerkAPIResponseError(error) && error.status === 404) {
      throw new Error(
        `Organisation ${args.orgId} is not on the Clerk instance for ${clerkEnv}.`,
        { cause: error }
      );
    }
    throw error;
  }

  const target = wranglerTarget(args);
  const execute = (sql: string, extra: string[] = []) =>
    wrangler([
      "d1",
      "execute",
      "DB",
      ...target,
      ...extra,
      "--command",
      sql,
      "-y",
    ]);

  await execute(
    insertSql({
      createdAt: new Date().toISOString(),
      id: ulid(),
      name: args.name,
      orgId: args.orgId,
    })
  );
  const out = await execute(selectSql(args.orgId), ["--json"]);
  const parsed = JSON.parse(out.slice(out.indexOf("["))) as {
    results: { id: string; name: string }[];
  }[];
  const row = parsed[0]?.results[0];
  if (!row) {
    throw new Error(`Workspace for ${args.orgId} is missing after the insert.`);
  }
  console.log(`${args.orgId} has workspace ${row.id} ("${row.name}").`);
};

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "add-workspace failed"
  );
  process.exit(1);
}
