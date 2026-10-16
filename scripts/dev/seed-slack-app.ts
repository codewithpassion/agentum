#!/usr/bin/env bun
// Seeds the local database that `bun run dev` in apps/web uses with an
// installed Slack app for an agent, and the identity link for the replayed
// sender, so `slack-replay.ts` produces a run. Without `--secret` it makes a
// signing secret and prints it on stdout. Progress and errors go to stderr.
// Run from the repo root:
// `bun scripts/dev/seed-slack-app.ts <agentId> [--secret <signing secret>] [--clerk-user <id>]`.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Database } from "@repo/db";
import { type Statement, sqliteAtomic } from "@repo/db/atomic";
import { encryptSecret, importSecretsKey } from "@repo/services/crypto";
import { slackSecretBinding } from "@repo/services/slack/apps";
import { and, eq, or } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  devUserPrincipal,
  ENV_FILE,
  LocalError,
  openLocalDatabase,
  requireOrgId,
  runCli,
} from "./local.ts";

// The boundary lint keeps `@repo/db/schema/*` to services, so this script
// declares the columns it reads and writes. Keep them in step with
// packages/db/src/schema/agents.ts, slack.ts and workspaces.ts.
const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
});
const slackApps = sqliteTable("slack_apps", {
  agentId: text("agent_id").notNull(),
  appId: text("app_id").notNull(),
  botToken: text("bot_token"),
  botUserId: text("bot_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  id: text("id").primaryKey(),
  signingSecret: text("signing_secret").notNull(),
  status: text("status").notNull(),
  teamId: text("team_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
});
const identityLinks = sqliteTable("identity_links", {
  clerkUserId: text("clerk_user_id").notNull(),
  createdAt: text("created_at").notNull(),
  email: text("email").notNull(),
  externalUserId: text("external_user_id").notNull(),
  id: text("id").primaryKey(),
  provider: text("provider").notNull(),
  teamId: text("team_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
});

const SECRETS_KEY = "SECRETS_KEY";
const APP_ID = "A0APP";
const TEAM_ID = "T0TEAM";
const BOT_USER_ID = "U0BOT";
const BOT_TOKEN = "xoxb-dev";
const SENDER_USER_ID = "U0DOM";
const IDENTITY_PROVIDER = "slack";
const LINK_EMAIL = "dev@example.com";
const DEFAULT_CLERK_USER = "dev-script";
const GENERATED_SECRET_BYTES = 32;

const secretsKeyFromEnvFile = (contents: string): string | undefined => {
  const line = contents
    .split("\n")
    .find((candidate) => candidate.startsWith(`${SECRETS_KEY}=`));
  return line?.slice(SECRETS_KEY.length + 1);
};

/** The `SECRETS_KEY` from the environment or `.env.local`, or null. */
export const readSecretsKey = (): string | null => {
  const value =
    process.env[SECRETS_KEY] ??
    (existsSync(ENV_FILE)
      ? secretsKeyFromEnvFile(readFileSync(ENV_FILE, "utf8"))
      : undefined);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

/** The key from `readSecretsKey`, or a LocalError that says how to set it. */
export const requireSecretsKey = (): string => {
  const key = readSecretsKey();
  if (!key) {
    throw new LocalError(
      `SECRETS_KEY is not set in the environment or ${ENV_FILE}. Add a line SECRETS_KEY=<base64 of 32 random bytes>, for example from \`openssl rand -base64 32\`, then run this again.`
    );
  }
  return key;
};

export interface SeedSlackAppInput {
  agentId: string;
  clerkUserId: string;
  db: Database;
  /** The app's signing secret, in plain text. Stored encrypted. */
  secret: string;
  /** Base64 of the 32-byte `SECRETS_KEY`. */
  secretsKey: string;
  workspaceId: string;
}

/**
 * Installs the dev Slack app for `agentId` in the workspace, replacing an
 * earlier install of the same agent and team, and links the sender to
 * `clerkUserId` unless the link exists. One atomic write.
 */
export const seedSlackApp = async ({
  agentId,
  clerkUserId,
  db,
  secret,
  secretsKey,
  workspaceId,
}: SeedSlackAppInput): Promise<void> => {
  const agentRows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.workspaceId, workspaceId)));
  if (agentRows.length === 0) {
    throw new LocalError(`No agent ${agentId} in this dev workspace.`);
  }

  const linkRows = await db
    .select({ id: identityLinks.id })
    .from(identityLinks)
    .where(
      and(
        eq(identityLinks.workspaceId, workspaceId),
        eq(identityLinks.provider, IDENTITY_PROVIDER),
        eq(identityLinks.teamId, TEAM_ID),
        eq(identityLinks.externalUserId, SENDER_USER_ID)
      )
    );

  const key = await importSecretsKey(secretsKey);
  const appId = crypto.randomUUID();
  const binding = { id: appId, workspaceId };
  const createdAt = new Date().toISOString();

  const statements: Statement[] = [
    db
      .delete(slackApps)
      .where(
        and(
          eq(slackApps.workspaceId, workspaceId),
          or(
            eq(slackApps.appId, APP_ID),
            and(eq(slackApps.agentId, agentId), eq(slackApps.teamId, TEAM_ID))
          )
        )
      ),
    db.insert(slackApps).values({
      agentId,
      appId: APP_ID,
      botToken: await encryptSecret(
        key,
        slackSecretBinding(binding, "bot_token"),
        BOT_TOKEN
      ),
      botUserId: BOT_USER_ID,
      createdAt,
      id: appId,
      signingSecret: await encryptSecret(
        key,
        slackSecretBinding(binding, "signing_secret"),
        secret
      ),
      status: "installed",
      teamId: TEAM_ID,
      workspaceId,
    }),
  ];
  if (linkRows.length === 0) {
    statements.push(
      db.insert(identityLinks).values({
        clerkUserId,
        createdAt,
        email: LINK_EMAIL,
        externalUserId: SENDER_USER_ID,
        id: crypto.randomUUID(),
        provider: IDENTITY_PROVIDER,
        teamId: TEAM_ID,
        workspaceId,
      })
    );
  }
  await sqliteAtomic(db)(statements);
};

export const main = async (argv: string[]): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args: argv,
    options: {
      "clerk-user": { type: "string" },
      secret: { type: "string" },
    },
  });
  const [agentId] = positionals;
  if (!agentId) {
    throw new LocalError(
      "Pass an agent id, such as the one seed-fake-agent.ts prints."
    );
  }
  const orgId = requireOrgId();
  const secretsKey = requireSecretsKey();
  const secret =
    values.secret ?? randomBytes(GENERATED_SECRET_BYTES).toString("hex");

  const local = openLocalDatabase();
  try {
    const principal = await devUserPrincipal(local.db, orgId);
    await seedSlackApp({
      agentId,
      clerkUserId: values["clerk-user"] ?? DEFAULT_CLERK_USER,
      db: local.db,
      secret,
      secretsKey,
      workspaceId: principal.workspaceId,
    });
    process.stderr.write(
      `Seeded Slack app ${APP_ID} for agent ${agentId} in ${local.file}.\n`
    );
  } finally {
    local.close();
  }
  if (values.secret === undefined) {
    process.stdout.write(`${secret}\n`);
  }
};

if (import.meta.main) {
  runCli(() => main(process.argv.slice(2)));
}
