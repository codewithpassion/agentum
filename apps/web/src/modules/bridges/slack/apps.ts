import { and, asc, eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "#/crypto";
import type { Db } from "#/db/client";
import { channelBridges, type SlackApp, slackApps } from "../schema";
import { slackAuthTest } from "./client";

/**
 * The `slack_apps` lifecycle: a draft row exists first so the wizard has an id
 * to put in the manifest's events URL, and the tokens arrive afterwards, when
 * the user has created the app in Slack and can copy them out of it.
 *
 * Tokens are write-only. They enter through `storeSlackAppTokens`, leave only
 * through `slackAppCredentials` (server-internal), and never appear in a view.
 */

/** One app per agent - the wizard turns this into a 409. */
export class SlackAppExistsError extends Error {
  constructor() {
    super("This agent is already connected to Slack.");
    this.name = "SlackAppExistsError";
  }
}

/** The shape every transport may hand out: no `*_enc` column ever leaves here. */
export interface SlackAppView {
  agentId: string;
  botUserId: string | null;
  createdAt: Date;
  id: string;
  lastError: string | null;
  status: SlackApp["status"];
  teamId: string | null;
  teamName: string | null;
  updatedAt: Date;
}

export const toSlackAppView = (app: SlackApp): SlackAppView => ({
  agentId: app.agentId,
  botUserId: app.botUserId,
  createdAt: app.createdAt,
  id: app.id,
  lastError: app.lastError,
  status: app.status,
  teamId: app.teamId,
  teamName: app.teamName,
  updatedAt: app.updatedAt,
});

// --- reads ------------------------------------------------------------------

export const getSlackAppForAgent = async (
  db: Db,
  workspaceId: string,
  agentId: string
): Promise<SlackApp | undefined> => {
  const [app] = await db
    .select()
    .from(slackApps)
    .where(
      and(
        eq(slackApps.workspaceId, workspaceId),
        eq(slackApps.agentId, agentId)
      )
    );
  return app;
};

export const getSlackAppInWorkspace = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<SlackApp | undefined> => {
  const [app] = await db
    .select()
    .from(slackApps)
    .where(and(eq(slackApps.workspaceId, workspaceId), eq(slackApps.id, id)));
  return app;
};

/**
 * Global by design, like `findBridgeByExternalChannel`: an inbound Slack event
 * carries no session, and this row is what names the tenant it belongs to.
 */
export const findSlackAppById = async (
  db: Db,
  id: string
): Promise<SlackApp | undefined> => {
  const [app] = await db.select().from(slackApps).where(eq(slackApps.id, id));
  return app;
};

export const listSlackApps = (
  db: Db,
  workspaceId: string
): Promise<SlackApp[]> =>
  db
    .select()
    .from(slackApps)
    .where(eq(slackApps.workspaceId, workspaceId))
    .orderBy(asc(slackApps.createdAt));

// --- writes -----------------------------------------------------------------

/**
 * Step 1 of the wizard. The row is `draft`: it holds no credentials yet, and
 * its only job is to exist so the manifest can name its events URL.
 */
export const createDraftSlackApp = async (
  db: Db,
  workspaceId: string,
  agentId: string
): Promise<SlackApp> => {
  if (await getSlackAppForAgent(db, workspaceId, agentId)) {
    throw new SlackAppExistsError();
  }

  const [app] = await db
    .insert(slackApps)
    .values({ agentId, id: crypto.randomUUID(), status: "draft", workspaceId })
    .returning();
  if (!app) {
    throw new Error("Failed to create the Slack app.");
  }
  return app;
};

const updateSlackApp = async (
  db: Db,
  id: string,
  values: Partial<typeof slackApps.$inferInsert>
): Promise<SlackApp> => {
  const [app] = await db
    .update(slackApps)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(slackApps.id, id))
    .returning();
  if (!app) {
    throw new Error("The Slack app disappeared while it was being saved.");
  }
  return app;
};

export interface SlackTokenInput {
  botToken: string;
  signingSecret: string;
}

export type StoreTokensResult =
  | { app: SlackApp; ok: true }
  | { app: SlackApp; error: string; ok: false };

/**
 * Step 2. `auth.test` both proves the bot token works and says where it works:
 * the team it is installed in and the bot's own user id. The signing secret
 * cannot be checked here - only an inbound event proves it - so it is stored
 * on the strength of the token, and the first verified event confirms it.
 *
 * A failure leaves Slack's own error on the row (`invalid_auth`,
 * `account_inactive`, …), which is what the wizard shows.
 */
export const storeSlackAppTokens = async (
  db: Db,
  key: string,
  app: SlackApp,
  input: SlackTokenInput,
  fetchImpl?: typeof fetch
): Promise<StoreTokensResult> => {
  const identity = await slackAuthTest(input.botToken, fetchImpl);
  if (!identity.ok) {
    const failed = await updateSlackApp(db, app.id, {
      lastError: identity.error,
      status: "error",
    });
    return { app: failed, error: identity.error, ok: false };
  }

  const updated = await updateSlackApp(db, app.id, {
    botTokenEnc: await encryptSecret(key, input.botToken),
    botUserId: identity.botUserId,
    lastError: null,
    signingSecretEnc: await encryptSecret(key, input.signingSecret),
    status: "active",
    teamId: identity.teamId,
    teamName: identity.teamName,
  });
  return { app: updated, ok: true };
};

/**
 * Disconnecting takes the bridges with it: a bridge belongs to an app, and one
 * left behind would name a Slack channel nothing can post to or hear from.
 */
export const deleteSlackApp = async (db: Db, app: SlackApp): Promise<void> => {
  await db.delete(channelBridges).where(eq(channelBridges.slackAppId, app.id));
  await db.delete(slackApps).where(eq(slackApps.id, app.id));
};

/**
 * For the agent-delete cleanup. An app outlives its agent as an events URL
 * Slack can still reach and nothing in the app can any longer show: the wizard
 * only ever reaches an app through the agent that owns it.
 */
export const deleteSlackAppForAgent = async (
  db: Db,
  workspaceId: string,
  agentId: string
): Promise<void> => {
  const app = await getSlackAppForAgent(db, workspaceId, agentId);
  if (app) {
    await deleteSlackApp(db, app);
  }
};

/** For the workspace-delete cleanup; the bridges are removed alongside. */
export const deleteSlackAppsForWorkspace = async (
  db: Db,
  workspaceId: string
): Promise<void> => {
  await db.delete(slackApps).where(eq(slackApps.workspaceId, workspaceId));
};

// --- credentials (server-internal) ------------------------------------------

export interface SlackAppCredentials {
  botToken: string;
  signingSecret: string;
}

/**
 * The one way back out of the encrypted columns, for the events route and the
 * mirror. `null` when the app has not been connected yet, or when the key is
 * missing - both of which mean "this app cannot be used", never "trust it".
 */
export const slackAppCredentials = async (
  key: string | null,
  app: SlackApp
): Promise<SlackAppCredentials | null> => {
  if (!(key && app.botTokenEnc && app.signingSecretEnc)) {
    return null;
  }
  return {
    botToken: await decryptSecret(key, app.botTokenEnc),
    signingSecret: await decryptSecret(key, app.signingSecretEnc),
  };
};

/** Just the signing secret: what the events route needs before anything else. */
export const slackAppSigningSecret = async (
  key: string | null,
  app: SlackApp
): Promise<string | null> => {
  if (!(key && app.signingSecretEnc)) {
    return null;
  }
  return await decryptSecret(key, app.signingSecretEnc);
};
