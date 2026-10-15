#!/usr/bin/env bun
/**
 * Config and secrets for the setup-previews skill, without printing a secret.
 * Commands:
 *
 *   staging-database <uuid>      set the staging D1 binding's database_id in
 *                                wrangler.jsonc
 *   token <account-id> [--dry-run]
 *                                create a Cloudflare API token for the preview
 *                                workflow with `cf`, and store it and the
 *                                account id as GitHub Actions secrets
 */
import { $, file, spawnSync, write } from "bun";

// Account-scoped: Workers Scripts Write (deploy previews), D1 Write (one
// database per PR). workers.dev hostnames need no zone permission.
const PERMISSION_GROUPS = [
  "e086da7e2179491d91ee5f35b3ca210a",
  "09b2857d1c31407795e75e3fed8617a1",
] as const;

const STAGING_DATABASE_ID =
  /("database_name":\s*"[^"]*-staging",[\s\S]*?"database_id":\s*)"[^"]*"/;

const root = (await $`git rev-parse --show-toplevel`.text()).trim();

const usage = () => {
  console.error(
    "usage: bun .claude/skills/setup-previews/previews.ts staging-database <uuid> | token <account-id> [--dry-run]"
  );
  process.exit(1);
};

/** cf prints a banner before the JSON body. */
const parseCfJson = (stdout: string): unknown =>
  JSON.parse(stdout.slice(stdout.indexOf("{")));

const createToken = async (accountId: string, dryRun: boolean) => {
  const policies = JSON.stringify([
    {
      effect: "allow",
      permission_groups: PERMISSION_GROUPS.map((id) => ({ id })),
      resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
    },
  ]);
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  // The project name keeps tokens from different projects apart in the account.
  const { name: project } = await file(`${root}/package.json`).json();
  const args = [
    "cf",
    "accounts",
    "tokens",
    "create",
    "--name",
    `github-actions-${project}-previews-${date}`,
    "--policies",
    policies,
  ];
  const env = { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId };
  if (dryRun) {
    spawnSync([...args, "--dry-run"], { env, stdout: "inherit" });
    return;
  }
  // Captured, never printed: stdout holds the token value.
  const created = spawnSync(args, { env, stderr: "inherit", stdout: "pipe" });
  if (created.exitCode !== 0) {
    console.error("cf accounts tokens create failed.");
    process.exit(1);
  }
  interface Token {
    id?: string;
    name?: string;
    value?: string;
  }
  // Older cf versions wrap the token in `result`; 1.0.0-beta.13 returns it bare.
  const body = parseCfJson(created.stdout.toString()) as Token & {
    result?: Token;
  };
  const { id: tokenId, name: tokenName, value } = body.result ?? body;
  // Checked before `gh secret set`, which would otherwise store an empty value.
  if (!value) {
    console.error("No token value in the cf response.");
    process.exit(1);
  }
  console.log(`Created token ${tokenName} (${tokenId})`);
  await $`gh secret set CLOUDFLARE_API_TOKEN < ${new Response(value)}`;
  await $`gh secret set CLOUDFLARE_ACCOUNT_ID --body ${accountId}`;
  await $`gh secret list`;
};

const [, , command, argument, flag] = process.argv;

if (command === "staging-database" && argument) {
  const configPath = `${root}/apps/web/wrangler.jsonc`;
  const text = await file(configPath).text();
  if (!STAGING_DATABASE_ID.test(text)) {
    console.error(`No staging D1 binding found in ${configPath}.`);
    process.exit(1);
  }
  await write(configPath, text.replace(STAGING_DATABASE_ID, `$1"${argument}"`));
  console.log(`staging database_id=${argument}`);
} else if (command === "token" && argument) {
  await createToken(argument, flag === "--dry-run");
} else {
  usage();
}
