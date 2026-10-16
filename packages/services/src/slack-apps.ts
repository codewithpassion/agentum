/**
 * Slack apps, the paste flow. A signed-in user downloads the manifest of an
 * agent, creates the app in Slack from it, installs it, and pastes the bot
 * token and signing secret back. The token is checked with Slack, then both
 * secrets are stored encrypted, bound to their row. Nothing here ever returns
 * a secret: a `SlackAppSummary` has no secret field at all.
 */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { slackApps } from "@repo/db/schema/slack";
import type { SlackAppStatus } from "@repo/db/shared";
import { and, desc, eq } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { encryptSecret, importSecretsKey } from "./crypto.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import { slackSecretBinding } from "./slack/apps.ts";
import {
  createSlackClient,
  type SlackCallResult,
  type SlackFetch,
} from "./slack/client.ts";
import { manifestJson } from "./slack/manifest.ts";
import type { Principal } from "./workspaces.ts";

const SLACK_APP_KIND = "slack_app";
const MANIFEST_ACTION = "slack_apps.manifest";
const LIST_ACTION = "slack_apps.list";
const PASTE_ACTION = "slack_apps.paste";
const REVOKE_ACTION = "slack_apps.revoke";

const idString = z.string().min(1).max(200);

export const slackManifestInputSchema = z.strictObject({ agentId: idString });
export type SlackManifestInput = z.input<typeof slackManifestInputSchema>;

export const slackAppListInputSchema = z.strictObject({ agentId: idString });
export type SlackAppListInput = z.input<typeof slackAppListInputSchema>;

/** A bot token starts `xoxb-`; a signing secret is 32 hex characters. */
export const slackAppPasteInputSchema = z.strictObject({
  agentId: idString,
  botToken: z
    .string()
    .trim()
    .max(300)
    .regex(
      /^xoxb-[A-Za-z0-9-]+$/,
      "That is not a bot token. It starts with xoxb- and is under OAuth & Permissions."
    ),
  signingSecret: z
    .string()
    .trim()
    .regex(
      /^[0-9a-f]{32}$/i,
      "That is not a signing secret. It is 32 letters and digits under Basic Information."
    ),
});
export type SlackAppPasteInput = z.input<typeof slackAppPasteInputSchema>;

export const slackAppRevokeInputSchema = z.strictObject({ id: idString });
export type SlackAppRevokeInput = z.input<typeof slackAppRevokeInputSchema>;

/** A Slack app as a signed-in user may see it. Has no secret of any kind. */
export interface SlackAppSummary {
  agentId: string;
  appId: string;
  botUserId: string;
  createdAt: string;
  id: string;
  status: SlackAppStatus;
  teamId: string;
}

const summaryColumns = {
  agentId: slackApps.agentId,
  appId: slackApps.appId,
  botUserId: slackApps.botUserId,
  createdAt: slackApps.createdAt,
  id: slackApps.id,
  status: slackApps.status,
  teamId: slackApps.teamId,
};

type UserPrincipal = Extract<Principal, { kind: "user" }>;

/** Apps are managed from a signed-in session: a Slack message cannot connect one. */
const requireUser = (principal: Principal, action: string): UserPrincipal => {
  if (principal.kind !== "user" || principal.via !== "session") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/** What a person can do about a failed Slack call, in words for the form. */
const refusalText = (result: SlackCallResult<object>): string => {
  switch (result.kind) {
    case "config":
    case "rejected":
      return `Slack did not accept that bot token (${result.error}).`;
    case "rate_limited":
      return "Slack asked us to slow down. Try again in a minute.";
    case "transient":
      return "Slack could not be reached. Try again.";
    default:
      return "Slack answered in a way we did not expect.";
  }
};

const describeAgent = (name: string): string =>
  `${name} is an agent in Harbourmaster. Mention it in a channel or message it directly.`;

export const createSlackAppsService = ({
  atomic,
  clock,
  db,
  events,
  fetch: slackFetch,
  publicBaseUrl,
  secretsKey,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  fetch: SlackFetch;
  /** `PUBLIC_BASE_URL`. The manifest's event URL is built on it. */
  publicBaseUrl?: string;
  /** `SECRETS_KEY`, base64. Needed to store a pasted secret. */
  secretsKey?: string;
}) => {
  let importedKey: Promise<CryptoKey> | undefined;
  const key = (): Promise<CryptoKey> => {
    if (!secretsKey) {
      throw new Error("Storing a Slack secret needs secretsKey (SECRETS_KEY).");
    }
    importedKey ??= importSecretsKey(secretsKey);
    return importedKey;
  };

  const requireAgent = async (principal: UserPrincipal, agentId: string) => {
    const agent = await findAgent(db, {
      id: agentId,
      workspaceId: principal.workspaceId,
    });
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    return agent;
  };

  /** The manifest to paste into Slack's "create app from manifest" form. */
  const manifest = async (
    principal: Principal,
    input: SlackManifestInput
  ): Promise<{ filename: string; json: string }> => {
    const user = requireUser(principal, MANIFEST_ACTION);
    const parsed = slackManifestInputSchema.parse(input);
    authorize(user, MANIFEST_ACTION, {
      kind: SLACK_APP_KIND,
      workspaceId: user.workspaceId,
    });
    if (!publicBaseUrl) {
      throw new ServiceError(
        "invalid",
        "PUBLIC_BASE_URL is not set, so the event URL cannot be built."
      );
    }
    const agent = await requireAgent(user, parsed.agentId);
    return {
      filename: `${agent.slug}-slack-manifest.json`,
      json: manifestJson({
        description: describeAgent(agent.name),
        name: agent.name,
        origin: publicBaseUrl,
      }),
    };
  };

  const list = async (
    principal: Principal,
    input: SlackAppListInput
  ): Promise<SlackAppSummary[]> => {
    const user = requireUser(principal, LIST_ACTION);
    const parsed = slackAppListInputSchema.parse(input);
    authorize(user, LIST_ACTION, {
      kind: SLACK_APP_KIND,
      workspaceId: user.workspaceId,
    });
    return await db
      .select(summaryColumns)
      .from(slackApps)
      .where(
        and(
          eq(slackApps.workspaceId, user.workspaceId),
          eq(slackApps.agentId, parsed.agentId)
        )
      )
      .orderBy(desc(slackApps.createdAt), desc(slackApps.id));
  };

  const summaryOf = async (
    workspaceId: string,
    id: string
  ): Promise<SlackAppSummary> => {
    const [row] = await db
      .select(summaryColumns)
      .from(slackApps)
      .where(and(eq(slackApps.workspaceId, workspaceId), eq(slackApps.id, id)))
      .limit(1);
    if (!row) {
      throw new ServiceError("not_found", "Slack app not found");
    }
    return row;
  };

  /**
   * Checks the bot token with Slack, which also tells the workspace, the bot
   * user and (through the bot) the app id, then stores both secrets. A second
   * paste for the same agent and Slack workspace replaces the first, and
   * brings a revoked app back.
   */
  const paste = async (
    principal: Principal,
    input: SlackAppPasteInput
  ): Promise<SlackAppSummary> => {
    const user = requireUser(principal, PASTE_ACTION);
    const parsed = slackAppPasteInputSchema.parse(input);
    authorize(user, PASTE_ACTION, {
      kind: SLACK_APP_KIND,
      workspaceId: user.workspaceId,
    });
    const agent = await requireAgent(user, parsed.agentId);
    const aesKey = await key();

    const client = createSlackClient({
      fetch: slackFetch,
      token: parsed.botToken,
    });
    const auth = await client.authTest();
    if (auth.kind !== "ok") {
      throw new ServiceError("invalid", refusalText(auth));
    }
    if (auth.botId === null) {
      throw new ServiceError("invalid", "That token does not belong to a bot.");
    }
    const bot = await client.botInfo(auth.botId);
    if (bot.kind !== "ok") {
      throw new ServiceError("invalid", refusalText(bot));
    }

    const [existing] = await db
      .select({ id: slackApps.id })
      .from(slackApps)
      .where(
        and(
          eq(slackApps.workspaceId, user.workspaceId),
          eq(slackApps.agentId, agent.id),
          eq(slackApps.teamId, auth.teamId)
        )
      )
      .limit(1);
    const rowId = existing?.id ?? ulid(clock.now().getTime());
    const binding = (field: "bot_token" | "signing_secret") =>
      slackSecretBinding({ id: rowId, workspaceId: user.workspaceId }, field);
    const secrets = {
      botToken: await encryptSecret(
        aesKey,
        binding("bot_token"),
        parsed.botToken
      ),
      signingSecret: await encryptSecret(
        aesKey,
        binding("signing_secret"),
        parsed.signingSecret
      ),
    };
    const fields = {
      appId: bot.appId,
      botToken: secrets.botToken,
      botUserId: auth.userId,
      signingSecret: secrets.signingSecret,
      status: "installed",
    } as const;
    const write = existing
      ? db.update(slackApps).set(fields).where(eq(slackApps.id, rowId))
      : db.insert(slackApps).values({
          ...fields,
          agentId: agent.id,
          createdAt: clock.now().toISOString(),
          id: rowId,
          teamId: auth.teamId,
          workspaceId: user.workspaceId,
        });
    try {
      await atomic([
        write,
        events.insertStatement({
          actor: { id: user.userId, kind: "user" },
          agentId: agent.id,
          payload: {
            appId: bot.appId,
            slackAppRowId: rowId,
            teamId: auth.teamId,
          },
          type: "slack.app_installed",
          workspaceId: user.workspaceId,
        }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        // biome-ignore lint/style/useErrorCause: ServiceError takes no cause, and the SQL error adds nothing for the person.
        throw new ServiceError(
          "conflict",
          "That Slack app is already connected to an agent."
        );
      }
      throw error;
    }
    return await summaryOf(user.workspaceId, rowId);
  };

  /**
   * Stops the app: events for it are refused from now on and the bot token is
   * deleted. The signing secret stays as ciphertext in the row, which an
   * app that is not `installed` never reads. Removing the app from Slack is
   * the person's to do there.
   */
  const revoke = async (
    principal: Principal,
    input: SlackAppRevokeInput
  ): Promise<SlackAppSummary> => {
    const user = requireUser(principal, REVOKE_ACTION);
    const parsed = slackAppRevokeInputSchema.parse(input);
    authorize(user, REVOKE_ACTION, {
      id: parsed.id,
      kind: SLACK_APP_KIND,
      workspaceId: user.workspaceId,
    });
    const current = await summaryOf(user.workspaceId, parsed.id);
    if (current.status === "revoked") {
      return current;
    }
    await atomic([
      db
        .update(slackApps)
        .set({ botToken: null, clientSecret: null, status: "revoked" })
        .where(
          and(
            eq(slackApps.workspaceId, user.workspaceId),
            eq(slackApps.id, parsed.id)
          )
        ),
      events.insertStatement({
        actor: { id: user.userId, kind: "user" },
        agentId: current.agentId,
        payload: {
          appId: current.appId,
          slackAppRowId: current.id,
          teamId: current.teamId,
        },
        type: "slack.app_revoked",
        workspaceId: user.workspaceId,
      }),
    ]);
    return await summaryOf(user.workspaceId, parsed.id);
  };

  return { list, manifest, paste, revoke };
};

export type SlackAppsService = ReturnType<typeof createSlackAppsService>;
