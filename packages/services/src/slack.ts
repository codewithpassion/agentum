/**
 * Slack events. `receive` is everything the events route does before it
 * answers: check who is calling, turn a mention, a DM or a reply in a thread
 * the agent knows into a run, and write the dedupe row, the run and its
 * events in one atomic write. Nothing slow happens before the answer. File
 * downloads and the reply to an unknown sender come back as an `after` job for
 * the route to hand to `waitUntil`. The minute tick finishes any download that
 * job did not.
 *
 * In "all messages" mode a plain channel message is stored in `slack_messages`
 * and waits there. The minute tick's `runDueBatches` gives each channel's
 * waiting messages to the agent in one run, at most one run per channel every
 * five minutes. A message that starts a run is stored as already handed over.
 * Stored messages are kept for 90 days, and `purgeSeen` deletes the older ones.
 */
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { slackEventsSeen } from "@repo/db/schema/slack";
import { identityLinks, workspaces } from "@repo/db/schema/workspaces";
import { INPUT_FILES_MAX } from "@repo/db/shared";
import { and, eq, gte, lt } from "drizzle-orm";
import { ulid } from "ulidx";
import { ForbiddenError } from "./authz.ts";
import { hashToken } from "./crypto.ts";
import { isServiceError, isUniqueViolation } from "./errors.ts";
import type { EventsService, PeopleLookup } from "./events.ts";
import type { Clock, StartRunInput } from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import {
  createSecretReader,
  findAppByApiId,
  type SlackAppRow,
} from "./slack/apps.ts";
import { createBatchRunner } from "./slack/batch.ts";
import { createSlackClient, type SlackFetch } from "./slack/client.ts";
import {
  eventCallbackSchema,
  parseEvent,
  type SlackEvent,
  urlVerificationSchema,
} from "./slack/event-parse.ts";
import {
  deleteMessage,
  MESSAGE_RETENTION_MS,
  purgeMessagesBefore,
  storeMessageStatement,
  updateMessageText,
} from "./slack/messages.ts";
import { withRetry } from "./slack/post.ts";
import { verifySlackRequest } from "./slack/signature.ts";
import { slackSpeakerText } from "./slack/speaker.ts";
import type { SlackStatus } from "./slack/status.ts";
import { findThreadSession } from "./slack/threads.ts";
import { SYSTEM_PRINCIPAL } from "./workspaces.ts";

type Mention = Extract<SlackEvent, { kind: "message" }>;
type RefusalReason = "signature" | "team";

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
/** One `slack.event_refused` per app and reason in this window. */
const REFUSAL_WINDOW_MS = 10 * 60 * 1000;
const NO_TEXT_WITH_FILES = "(see the attached files)";
const UNLINKED_REPLY =
  "I don't know you yet. Ask an Agentum admin of this workspace to invite you, using the same email address as your Slack profile.";
const HIDDEN_EMAIL_REPLY =
  "I can't see the email address on your Slack profile, so I can't match you to an Agentum account. Ask an Agentum admin of this workspace to invite you, and make your email visible to apps in your Slack profile.";
const LINKED_REPLY =
  "I linked your Slack account to your Agentum account. Please send your message again.";
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const accepted: ReceiveResult = { kind: "accepted" };

/**
 * Whether a text mentions the app. Slack writes a mention as `<@U123>`, or
 * `<@U123|name>` with a display name, and both start with `<@U123`.
 */
const mentionsBot = (app: SlackAppRow, text: string): boolean =>
  text.includes(`<@${app.botUserId}`);

export const createSlackService = ({
  atomic,
  clock,
  db,
  directory,
  people,
  events,
  fetch: slackFetch,
  runs,
  secretsKey,
  status,
}: {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  directory: SlackDirectory;
  people?: PeopleLookup;
  events: EventsService;
  fetch: SlackFetch;
  runs: Pick<RunsService, "fetchPendingFiles" | "offerQueuedRun" | "startRun">;
  /** Shows the working status in the thread of a Slack-started run. */
  status: Pick<SlackStatus, "begin">;
  /** `SECRETS_KEY`, base64. */
  secretsKey?: string;
}) => {
  const secrets = createSecretReader(secretsKey);
  const batches = createBatchRunner({
    clock,
    db,
    events,
    fetch: slackFetch,
    runs,
    secretsKey,
  });

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

  /**
   * Writes `slack.event_refused` for a request a known app refused, at most one
   * per app and reason per window. The payload is the app id and the reason
   * only. A failure is logged and never changes the 401 answer.
   */
  const recordRefusal = async (app: SlackAppRow, reason: RefusalReason) => {
    try {
      const recent = await db
        .select({ payload: eventRows.payload })
        .from(eventRows)
        .where(
          and(
            eq(eventRows.workspaceId, app.workspaceId),
            eq(eventRows.type, "slack.event_refused"),
            eq(eventRows.agentId, app.agentId),
            gte(
              eventRows.createdAt,
              new Date(clock.now().getTime() - REFUSAL_WINDOW_MS).toISOString()
            )
          )
        );
      const written = recent.some((row) => {
        const payload = JSON.parse(row.payload ?? "{}") as {
          appId?: unknown;
          reason?: unknown;
        };
        return payload.appId === app.appId && payload.reason === reason;
      });
      if (written) {
        return;
      }
      await events.append({
        actor: { id: "slack", kind: "system" },
        agentId: app.agentId,
        payload: { appId: app.appId, reason },
        type: "slack.event_refused",
        workspaceId: app.workspaceId,
      });
    } catch (error) {
      console.error("Slack refusal not recorded", error);
    }
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

  /** The session of the thread a message is in, if the app knows it. */
  const threadSession = (app: SlackAppRow, event: Mention) =>
    findThreadSession(db, {
      agentId: app.agentId,
      channelId: event.channelId,
      teamId: app.teamId,
      threadTs: event.threadTs ?? event.ts,
      workspaceId: app.workspaceId,
    });

  /**
   * The statement that stores a message, or none when the message has no text
   * to keep. `batchedAt` is null for a message that waits for its batch, and the
   * time it was stored for one that already went to an agent in a run.
   */
  const storeMessage = (
    app: SlackAppRow,
    event: Mention,
    {
      batchedAt,
      clerkUserId,
      now,
    }: { batchedAt: string | null; clerkUserId: string | null; now: string }
  ): Statement[] => {
    if (event.text.trim() === "") {
      return [];
    }
    return [
      storeMessageStatement(db, {
        appId: app.id,
        batchedAt,
        channelId: event.channelId,
        clerkUserId,
        createdAt: now,
        slackUserId: event.userId,
        text: event.text,
        threadTs: event.threadTs ?? null,
        ts: event.ts,
        workspaceId: app.workspaceId,
      }),
    ];
  };

  /**
   * Stores a plain channel message for the app's batch. The sender's link names
   * the Agentum user when there is one. Nothing is logged: the text is
   * workspace data.
   */
  const storeChannelMessage = async (app: SlackAppRow, event: Mention) => {
    const link = await findLink(app, event.userId);
    await atomic(
      storeMessage(app, event, {
        batchedAt: null,
        clerkUserId: link?.clerkUserId ?? null,
        now: clock.now().toISOString(),
      })
    );
  };

  /**
   * A channel message the app does not answer. In "all" mode it waits for its
   * batch, unless it mentions the bot: the `app_mention` event carries that one.
   */
  const batchLater = async (app: SlackAppRow, event: Mention) => {
    if (app.listenMode === "all" && !mentionsBot(app, event.text)) {
      await storeChannelMessage(app, event);
    }
  };

  const admitUnlinked = async (
    app: SlackAppRow,
    event: Mention,
    eventHash: string
  ): Promise<ReceiveResult> => {
    // A stranger's reply in a thread is not addressed to the app: no reply, no
    // dedupe row. In "all" mode the agent still sees it in a batch.
    if (event.trigger === "thread") {
      await batchLater(app, event);
      return accepted;
    }
    const now = clock.now().toISOString();
    // A stranger's mention starts no run, so it is stored here as already handed
    // over. Otherwise the batch would answer a mention the app is replying to.
    const stored =
      app.listenMode === "all" && event.trigger === "mention"
        ? storeMessage(app, event, { batchedAt: now, clerkUserId: null, now })
        : [];
    await atomic([
      seenRow(app.workspaceId, eventHash, null),
      ...stored,
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
    const known = await threadSession(app, event);
    // A `ui` or private session answers only to its own actor. Another person's
    // reply in such a thread is a mention like any other, and a plain thread
    // reply is not addressed to the app.
    const thread =
      known &&
      (known.origin === "ui" || known.private) &&
      !(known.actorKind === "user" && known.actorId === clerkUserId)
        ? null
        : known;
    if (event.trigger === "thread" && !thread) {
      await batchLater(app, event);
      return accepted;
    }
    const pendingFiles = event.files
      .slice(0, INPUT_FILES_MAX)
      .map((file) => ({ ...file, teamId: app.teamId }));
    const now = clock.now().toISOString();
    const input: StartRunInput = {
      agentId: app.agentId,
      input: {
        text: await slackSpeakerText(db, people, {
          appId: app.id,
          channelId: event.channelId,
          teamId: app.teamId,
          text,
          threadTs,
          userId: clerkUserId,
          workspaceId: app.workspaceId,
        }),
      },
      reply: {
        channel: event.channelId,
        kind: "slack",
        teamId: app.teamId,
        threadTs,
      },
      session: thread
        ? { externalKey: thread.externalKey, origin: thread.origin }
        : {
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
          // Stored as already handed over, so no batch repeats what this run answers.
          ...storeMessage(app, event, {
            batchedAt: now,
            clerkUserId,
            now,
          }),
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
      // The status call runs beside the offer, so a slow Slack never delays the run.
      const statusShown = status
        .begin(started.runId, app.workspaceId)
        .catch((error: unknown) => {
          console.error("Slack status failed", error);
        });
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
      await statusShown;
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

  /** Acts on one parsed event from an app whose signature and team were checked. */
  const handleEvent = async (
    app: SlackAppRow,
    event: SlackEvent
  ): Promise<ReceiveResult> => {
    // An edit or a deletion changes only a row that exists. In either mode, a
    // message the app never stored matches no row and changes nothing.
    if (event.kind === "message_edited") {
      if (event.text !== "") {
        await updateMessageText(db, {
          appId: app.id,
          channelId: event.channelId,
          text: event.text,
          ts: event.ts,
        });
      }
      return accepted;
    }
    if (event.kind === "message_deleted") {
      await deleteMessage(db, {
        appId: app.id,
        channelId: event.channelId,
        ts: event.ts,
      });
      return accepted;
    }
    if (event.kind !== "message" || event.userId === app.botUserId) {
      return accepted;
    }
    // A channel message, or a thread reply in a thread the app does not know,
    // is not for the app to answer. In "all" mode it is stored for its batch.
    // Slack also sends a mention as an `app_mention`, which starts the run. So
    // this path writes no dedupe row, and it skips a mention for that reason.
    if (
      event.trigger === "channel" ||
      (event.trigger === "thread" && !(await threadSession(app, event)))
    ) {
      await batchLater(app, event);
      return accepted;
    }
    return await admit(app, event);
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
      console.warn("Slack event refused: unknown app", apiAppId);
      return { kind: "unauthorized" };
    }
    const verified = await verifySlackRequest({
      body: request.rawBody,
      now: clock.now().getTime(),
      signature: request.signature,
      signingSecret: await secrets.signingSecret(app),
      timestamp: request.timestamp,
    });
    if (!verified) {
      await recordRefusal(app, "signature");
      return { kind: "unauthorized" };
    }
    if (envelope.data.team_id !== app.teamId) {
      await recordRefusal(app, "team");
      return { kind: "unauthorized" };
    }
    return await handleEvent(app, parseEvent(payload));
  };

  /**
   * Trims the dedupe rows Slack can no longer retry, and the stored messages
   * older than the 90 day retention. The minute tick runs it.
   */
  const purgeSeen = async (): Promise<void> => {
    await db
      .delete(slackEventsSeen)
      .where(
        lt(
          slackEventsSeen.receivedAt,
          new Date(clock.now().getTime() - SEEN_TTL_MS).toISOString()
        )
      );
    await purgeMessagesBefore(
      db,
      new Date(clock.now().getTime() - MESSAGE_RETENTION_MS).toISOString()
    );
  };

  return { purgeSeen, receive, runDueBatches: batches.runDue };
};

export type SlackService = ReturnType<typeof createSlackService>;
