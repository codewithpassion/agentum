/**
 * Slack events. `receive` is everything the events route does before it
 * answers: check who is calling, turn a mention or a DM into a run, and write
 * the dedupe row, the run and its events in one atomic write. Nothing slow
 * happens before the answer. File downloads and the reply to an unknown sender
 * come back as an `after` job for the route to hand to `waitUntil`. The
 * minute tick finishes any download that job did not.
 */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { slackEventsSeen } from "@repo/db/schema/slack";
import { identityLinks, workspaces } from "@repo/db/schema/workspaces";
import { INPUT_FILES_MAX } from "@repo/db/shared";
import { and, eq, lt } from "drizzle-orm";
import { ulid } from "ulidx";
import { ForbiddenError } from "./authz.ts";
import { hashToken } from "./crypto.ts";
import { isServiceError, isUniqueViolation } from "./errors.ts";
import type { EventsService } from "./events.ts";
import type { Clock, StartRunInput } from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import {
  createSecretReader,
  findAppByApiId,
  type SlackAppRow,
} from "./slack/apps.ts";
import { createSlackClient, type SlackFetch } from "./slack/client.ts";
import {
  eventCallbackSchema,
  parseEvent,
  type SlackEvent,
  urlVerificationSchema,
} from "./slack/event-parse.ts";
import { withRetry } from "./slack/post.ts";
import { verifySlackRequest } from "./slack/signature.ts";
import { SYSTEM_PRINCIPAL } from "./workspaces.ts";

type Mention = Extract<SlackEvent, { kind: "message" }>;

/** Clerk, as the Slack link flow needs it. Implemented in apps/web. */
export interface SlackDirectory {
  /** The Clerk user with this verified email address, or null. */
  findUserIdByEmail: (email: string) => Promise<string | null>;
  isOrgMember: (userId: string, clerkOrgId: string) => Promise<boolean>;
}

export type ReceiveResult =
  /** Answer 200 with the work already durable. */
  | {
      kind: "accepted";
      /** Runs after the answer: file downloads, or the reply to an unknown sender. */
      after?: () => Promise<void>;
      runId?: string;
    }
  /** The Slack URL check: answer with this text. */
  | { challenge: string; kind: "challenge" }
  | { kind: "malformed" }
  | { kind: "unauthorized" };

/** `slack_events_seen` rows older than this are trimmed. Slack retries within minutes. */
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;
const NO_TEXT_WITH_FILES = "(see the attached files)";
const UNLINKED_REPLY =
  "I don't know you yet. Ask a Harbourmaster admin of this workspace to invite you, using the same email address as your Slack profile.";
const HIDDEN_EMAIL_REPLY =
  "I can't see the email address on your Slack profile, so I can't match you to a Harbourmaster account. Ask a Harbourmaster admin of this workspace to invite you, and make your email visible to apps in your Slack profile.";
const LINKED_REPLY =
  "I linked your Slack account to your Harbourmaster account. Please send your message again.";
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const accepted: ReceiveResult = { kind: "accepted" };

export const createSlackService = ({
  atomic,
  clock,
  db,
  directory,
  events,
  fetch: slackFetch,
  runs,
  secretsKey,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  directory: SlackDirectory;
  events: EventsService;
  fetch: SlackFetch;
  runs: Pick<RunsService, "fetchPendingFiles" | "offerQueuedRun" | "startRun">;
  /** `SECRETS_KEY`, base64. */
  secretsKey?: string;
}) => {
  const secrets = createSecretReader(secretsKey);

  const seenRow = (
    workspaceId: string,
    eventHash: string,
    runId: string | null
  ) =>
    db.insert(slackEventsSeen).values({
      eventHash,
      id: ulid(clock.now().getTime()),
      receivedAt: clock.now().toISOString(),
      runId,
      workspaceId,
    });

  const alreadySeen = async (eventHash: string): Promise<boolean> => {
    const [row] = await db
      .select({ id: slackEventsSeen.id })
      .from(slackEventsSeen)
      .where(eq(slackEventsSeen.eventHash, eventHash))
      .limit(1);
    return row !== undefined;
  };

  const findLink = async (app: SlackAppRow, slackUserId: string) => {
    const [link] = await db
      .select({ clerkUserId: identityLinks.clerkUserId })
      .from(identityLinks)
      .where(
        and(
          eq(identityLinks.workspaceId, app.workspaceId),
          eq(identityLinks.provider, "slack"),
          eq(identityLinks.teamId, app.teamId),
          eq(identityLinks.externalUserId, slackUserId)
        )
      )
      .limit(1);
    return link ?? null;
  };

  /** Posts in the thread the message arrived in, as the app's bot. */
  const replyInThread = async (
    app: SlackAppRow,
    event: Mention,
    text: string
  ) => {
    const token = await secrets.botToken(app);
    if (!token) {
      return;
    }
    const client = createSlackClient({ fetch: slackFetch, token });
    await withRetry(clock, () =>
      client.postMessage({
        channel: event.channelId,
        text,
        threadTs: event.threadTs ?? event.ts,
      })
    );
  };

  /**
   * The sender has no link yet. Look their email up in Slack; when a Clerk
   * user has that verified address and belongs to the workspace's
   * organisation, link them. Anyone else is told to ask for access.
   */
  const meetUnlinkedSender = async (app: SlackAppRow, event: Mention) => {
    const token = await secrets.botToken(app);
    if (!token) {
      return;
    }
    const client = createSlackClient({ fetch: slackFetch, token });
    const lookup = await client.userEmail(event.userId);
    const email = lookup.kind === "ok" ? lookup.email : null;
    const clerkUserId = email ? await directory.findUserIdByEmail(email) : null;
    const [workspace] = await db
      .select({ clerkOrgId: workspaces.clerkOrgId })
      .from(workspaces)
      .where(eq(workspaces.id, app.workspaceId))
      .limit(1);
    const member =
      email &&
      clerkUserId &&
      workspace &&
      (await directory.isOrgMember(clerkUserId, workspace.clerkOrgId));
    if (!(email && clerkUserId && member)) {
      await replyInThread(
        app,
        event,
        email ? UNLINKED_REPLY : HIDDEN_EMAIL_REPLY
      );
      return;
    }
    await db
      .insert(identityLinks)
      .values({
        clerkUserId,
        createdAt: clock.now().toISOString(),
        email,
        externalUserId: event.userId,
        id: ulid(clock.now().getTime()),
        provider: "slack",
        teamId: app.teamId,
        workspaceId: app.workspaceId,
      })
      .onConflictDoNothing();
    await replyInThread(app, event, LINKED_REPLY);
  };

  /**
   * Records what Slack calls the place the session started in, "#channel" or
   * "DM with <name>", for the sessions list to title it by. This is a Slack
   * API call, so it runs after the answer. Without the token, the scope or a
   * name, no event is written and the list falls back to the first message.
   */
  const nameSession = async (
    app: SlackAppRow,
    event: Mention,
    sessionId: string
  ) => {
    const token = await secrets.botToken(app);
    if (!token) {
      return;
    }
    const client = createSlackClient({ fetch: slackFetch, token });
    const isDm = event.trigger === "dm";
    const lookup = isDm
      ? await client.userName(event.userId)
      : await client.channelName(event.channelId);
    if (lookup.kind !== "ok" || lookup.name === null) {
      return;
    }
    await events.append({
      actor: { id: "slack", kind: "system" },
      agentId: app.agentId,
      payload: { label: isDm ? `DM with ${lookup.name}` : `#${lookup.name}` },
      sessionId,
      type: "slack.named",
      workspaceId: app.workspaceId,
    });
  };

  /** The text the agent sees: the message without the bot's own mention. */
  const promptText = (app: SlackAppRow, event: Mention): string =>
    event.text
      .replace(
        new RegExp(
          `<@${app.botUserId.replace(REGEX_SPECIALS, "\\$&")}(\\|[^>]*)?>`,
          "g"
        ),
        ""
      )
      .trim();

  const admitUnlinked = async (
    app: SlackAppRow,
    event: Mention,
    eventHash: string
  ): Promise<ReceiveResult> => {
    await atomic([
      seenRow(app.workspaceId, eventHash, null),
      events.insertStatement({
        actor: { id: "slack", kind: "system" },
        agentId: app.agentId,
        payload: {
          channel: event.channelId,
          slackUserId: event.userId,
          ts: event.ts,
        },
        type: "slack.unlinked_sender",
        workspaceId: app.workspaceId,
      }),
    ]);
    return {
      after: async () => {
        try {
          await meetUnlinkedSender(app, event);
        } catch (error) {
          console.error("Slack unlinked sender reply failed", error);
        }
      },
      kind: "accepted",
    };
  };

  const admitRun = async (
    app: SlackAppRow,
    event: Mention,
    eventHash: string,
    clerkUserId: string,
    text: string
  ): Promise<ReceiveResult> => {
    const threadTs = event.threadTs ?? event.ts;
    const pendingFiles = event.files
      .slice(0, INPUT_FILES_MAX)
      .map((file) => ({ ...file, teamId: app.teamId }));
    const input: StartRunInput = {
      agentId: app.agentId,
      input: { text },
      reply: {
        channel: event.channelId,
        kind: "slack",
        teamId: app.teamId,
        threadTs,
      },
      session: {
        externalKey: `${app.teamId}:${event.channelId}:${threadTs}`,
        origin: "slack",
        private: event.trigger === "dm",
      },
    };
    const started = await runs.startRun(
      {
        kind: "user",
        userId: clerkUserId,
        via: "slack",
        workspaceId: app.workspaceId,
      },
      input,
      {
        alongside: ({ runId, sessionId }) => [
          seenRow(app.workspaceId, eventHash, runId),
          events.insertStatement({
            actor: { id: clerkUserId, kind: "user" },
            agentId: app.agentId,
            payload: {
              channel: event.channelId,
              threadTs,
              trigger: event.trigger,
              ts: event.ts,
            },
            runId,
            sessionId,
            type: "slack.received",
            workspaceId: app.workspaceId,
          }),
        ],
        offerLater: true,
        pendingFiles: pendingFiles.length > 0 ? pendingFiles : undefined,
      }
    );
    // Offering the run and fetching its files come after the answer. If the
    // job is lost, the minute tick does the same for a run nobody offered.
    const afterAnswer = async () => {
      try {
        await (pendingFiles.length > 0
          ? runs.fetchPendingFiles(SYSTEM_PRINCIPAL, started.runId)
          : runs.offerQueuedRun(SYSTEM_PRINCIPAL, started.runId));
      } catch (error) {
        console.error("Slack run follow-up failed", error);
      }
      try {
        await nameSession(app, event, started.sessionId);
      } catch (error) {
        console.error("Slack session naming failed", error);
      }
    };
    return { after: afterAnswer, kind: "accepted", runId: started.runId };
  };

  /** A message that passed the signature check and is for the app to answer. */
  const admit = async (
    app: SlackAppRow,
    event: Mention
  ): Promise<ReceiveResult> => {
    const text = promptText(app, event);
    if (text === "" && event.files.length === 0) {
      return accepted;
    }
    // One message, however Slack delivers it: a retry has the same event id, and
    // a DM that also mentions the app arrives as two events with the same ts.
    const eventHash = await hashToken(
      `${app.appId}:${event.channelId}:${event.ts}`
    );
    if (await alreadySeen(eventHash)) {
      return accepted;
    }
    try {
      const link = await findLink(app, event.userId);
      return link
        ? await admitRun(
            app,
            event,
            eventHash,
            link.clerkUserId,
            text === "" ? NO_TEXT_WITH_FILES : text
          )
        : await admitUnlinked(app, event, eventHash);
    } catch (error) {
      // Two deliveries of one event at the same moment: the other one won.
      if (isUniqueViolation(error) && (await alreadySeen(eventHash))) {
        return accepted;
      }
      // An archived agent or a refused principal will not get better on a
      // retry, so Slack is told 200. Anything else is ours and Slack retries.
      if (isServiceError(error) || error instanceof ForbiddenError) {
        console.warn("Slack message not admitted:", error.message);
        return accepted;
      }
      throw error;
    }
  };

  /**
   * Authenticates and admits one request. `rawBody` is the body exactly as
   * Slack sent it. Throws when the atomic write fails, so the route answers
   * 500 and Slack delivers the event again.
   */
  const receive = async (request: {
    rawBody: string;
    signature: string;
    timestamp: string;
  }): Promise<ReceiveResult> => {
    let payload: unknown;
    try {
      payload = JSON.parse(request.rawBody);
    } catch {
      return { kind: "malformed" };
    }
    // The challenge carries no app id, and the app row cannot exist yet when
    // Slack checks the URL while the app is being created from its manifest,
    // so it cannot be signed against. Echoing a string back gives nothing away.
    const challenge = urlVerificationSchema.safeParse(payload);
    if (challenge.success) {
      return { challenge: challenge.data.challenge, kind: "challenge" };
    }
    const envelope = eventCallbackSchema.safeParse(payload);
    if (!envelope.success) {
      return { kind: "malformed" };
    }
    const apiAppId = envelope.data.api_app_id;
    const app = apiAppId ? await findAppByApiId(db, apiAppId) : null;
    if (!app) {
      return { kind: "unauthorized" };
    }
    const verified = await verifySlackRequest({
      body: request.rawBody,
      now: clock.now().getTime(),
      signature: request.signature,
      signingSecret: await secrets.signingSecret(app),
      timestamp: request.timestamp,
    });
    if (!verified || envelope.data.team_id !== app.teamId) {
      return { kind: "unauthorized" };
    }
    const event = parseEvent(payload);
    if (event.kind !== "message" || event.userId === app.botUserId) {
      return accepted;
    }
    return await admit(app, event);
  };

  /** Trims the dedupe rows Slack can no longer retry. */
  const purgeSeen = async (): Promise<void> => {
    await db
      .delete(slackEventsSeen)
      .where(
        lt(
          slackEventsSeen.receivedAt,
          new Date(clock.now().getTime() - SEEN_TTL_MS).toISOString()
        )
      );
  };

  return { purgeSeen, receive };
};

export type SlackService = ReturnType<typeof createSlackService>;
