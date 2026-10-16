/**
 * Reading `slack_apps`. The signing secret and bot token are stored
 * encrypted, bound to their workspace, table, row and column, so a ciphertext
 * copied to another row does not decrypt. The paste flow (M5.2) writes them
 * with `slackSecretBinding`.
 */
import type { Database } from "@repo/db";
import { slackApps } from "@repo/db/schema/slack";
import { and, eq } from "drizzle-orm";
import {
  decryptSecret,
  importSecretsKey,
  type SecretBinding,
} from "../crypto.ts";

export type SlackAppRow = typeof slackApps.$inferSelect;

export type SlackSecretField = "bot_token" | "signing_secret";

export const slackSecretBinding = (
  app: Pick<SlackAppRow, "id" | "workspaceId">,
  field: SlackSecretField
): SecretBinding => ({
  field,
  rowId: app.id,
  table: "slack_apps",
  workspaceId: app.workspaceId,
});

/** The installed app for Slack's `api_app_id`. */
export const findAppByApiId = async (
  db: Database,
  appId: string
): Promise<SlackAppRow | null> => {
  const [row] = await db
    .select()
    .from(slackApps)
    .where(and(eq(slackApps.appId, appId), eq(slackApps.status, "installed")))
    .limit(1);
  return row ?? null;
};

/** The installed app of an agent in one Slack workspace. */
export const findInstalledApp = async (
  db: Database,
  query: { agentId: string; teamId: string; workspaceId: string }
): Promise<SlackAppRow | null> => {
  const [row] = await db
    .select()
    .from(slackApps)
    .where(
      and(
        eq(slackApps.workspaceId, query.workspaceId),
        eq(slackApps.agentId, query.agentId),
        eq(slackApps.teamId, query.teamId),
        eq(slackApps.status, "installed")
      )
    )
    .limit(1);
  return row ?? null;
};

/** Decrypts the secrets of app rows under `SECRETS_KEY`. */
export const createSecretReader = (secretsKey: string | undefined) => {
  let imported: Promise<CryptoKey> | undefined;
  const read = (
    app: SlackAppRow,
    field: SlackSecretField,
    stored: string
  ): Promise<string> => {
    if (!secretsKey) {
      throw new Error("Reading Slack secrets needs secretsKey (SECRETS_KEY).");
    }
    imported ??= importSecretsKey(secretsKey);
    return imported.then((key) =>
      decryptSecret(key, slackSecretBinding(app, field), stored)
    );
  };
  return {
    /** Null when the app has no bot token yet. */
    botToken: (app: SlackAppRow): Promise<string | null> =>
      app.botToken === null
        ? Promise.resolve(null)
        : read(app, "bot_token", app.botToken),
    signingSecret: (app: SlackAppRow): Promise<string> =>
      read(app, "signing_secret", app.signingSecret),
  };
};

export type SecretReader = ReturnType<typeof createSecretReader>;
