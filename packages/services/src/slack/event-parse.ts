/**
 * The inbound half of the Events API: what Slack posts to the events URL when
 * a person sends the app a direct message, mentions it in a channel, replies
 * in a thread in a channel, or shares a file with a message.
 *
 * Two payload shapes arrive at that URL. `url_verification` is the challenge
 * Slack issues while the request URL is being configured, and the route has to
 * echo the `challenge` back or the subscription is never saved
 * (https://docs.slack.dev/apis/events-api/using-http-request-urls.md#verification).
 * `event_callback` is the wrapper around every real event
 * (https://docs.slack.dev/apis/events-api.md#callback-field).
 *
 * The schemas are `z.object` (unknown keys dropped) rather than
 * `z.strictObject`: Slack adds fields to these payloads and a new one must not
 * turn a real message into a parse failure.
 *
 * Nothing here authenticates anything. `verifySlackRequest` in `signature.ts`
 * runs over the raw body first.
 */

import { z } from "zod";

/** The configuration-time challenge. Echo `challenge` back with a 200. */
export const urlVerificationSchema = z.object({
  challenge: z.string().min(1),
  type: z.literal("url_verification"),
});

/**
 * A file on a message (https://docs.slack.dev/reference/objects/file-object).
 * Every field is optional: a tombstone, a file the app cannot download, or a
 * file from an older payload may lack any of them, and the mapping below
 * decides what to keep.
 */
export const slackFileSchema = z.object({
  id: z.string().nullish(),
  mimetype: z.string().nullish(),
  mode: z.string().nullish(),
  name: z.string().nullish(),
  size: z.number().nullish(),
  url_private_download: z.string().nullish(),
});

/**
 * The message an edit changed, as Slack nests it under `message` on a
 * `message_changed` event. Its `ts` is the original message's ts.
 */
export const editedMessageSchema = z.object({
  app_id: z.string().nullish(),
  bot_id: z.string().nullish(),
  bot_profile: z.unknown().optional(),
  subtype: z.string().nullish(),
  text: z.string().nullish(),
  ts: z.string().nullish(),
  user: z.string().nullish(),
});

/**
 * A message in a DM (`channel_type` `im`), or in any other conversation the
 * app receives it from. `bot_id`, `bot_profile` and `app_id` are the fields
 * that keep the app from answering itself: its own replies arrive here too
 * (https://docs.slack.dev/reference/events/message.im.md), and the docs do
 * not promise which of the three an echo carries. An edit carries `message`,
 * a deletion carries `deleted_ts`.
 */
export const messageImEventSchema = z.object({
  // Nullish, not optional: Slack's own file_share sample for a person's DM
  // carries `"bot_id": null`, and a null must not make the message malformed.
  app_id: z.string().nullish(),
  bot_id: z.string().nullish(),
  bot_profile: z.unknown().optional(),
  channel: z.string(),
  channel_type: z.string().nullish(),
  deleted_ts: z.string().nullish(),
  files: z.array(slackFileSchema).nullish(),
  message: editedMessageSchema.nullish(),
  subtype: z.string().nullish(),
  text: z.string().nullish(),
  thread_ts: z.string().nullish(),
  ts: z.string(),
  type: z.literal("message"),
  user: z.string().nullish(),
});

/**
 * A mention of the app in a channel
 * (https://docs.slack.dev/reference/events/app_mention.md). It carries no
 * `channel_type`, and `thread_ts` only when the mention was written inside
 * a thread. The same three bot fields as a DM keep the app from answering
 * another app, or itself.
 */
export const appMentionEventSchema = z.object({
  app_id: z.string().nullish(),
  bot_id: z.string().nullish(),
  bot_profile: z.unknown().optional(),
  channel: z.string(),
  files: z.array(slackFileSchema).nullish(),
  subtype: z.string().nullish(),
  text: z.string().nullish(),
  thread_ts: z.string().nullish(),
  ts: z.string(),
  type: z.literal("app_mention"),
  user: z.string().nullish(),
});

/**
 * The envelope. `event_id` is the deduplication key: Slack retries a delivery
 * up to three times when the route does not answer within three seconds
 * (https://docs.slack.dev/apis/events-api.md), and a retried request must not
 * be answered twice.
 */
export const eventCallbackSchema = z.object({
  api_app_id: z.string().optional(),
  /** Loose, so the inner event keeps the fields its own schema reads. */
  event: z.looseObject({ type: z.string() }),
  event_id: z.string(),
  event_time: z.number().optional(),
  team_id: z.string(),
  type: z.literal("event_callback"),
});

/** A file the app can download, with Slack's names mapped to ours. */
export interface SlackFile {
  id: string;
  mimetype: string;
  name: string;
  size: number;
  url: string;
}

/**
 * Why a payload is not something to act on. None of these is an error: one
 * events URL receives everything the app is subscribed to, plus the app's own
 * messages coming back around.
 */
export type IgnoredReason =
  | "bot_message"
  | "message_subtype"
  | "no_sender"
  | "unsupported_event";

export type SlackEvent =
  | { challenge: string; kind: "url_verification" }
  | { detail: string; kind: "malformed" }
  | { kind: "ignored"; reason: IgnoredReason }
  | {
      apiAppId: string | undefined;
      channelId: string;
      eventId: string;
      files: SlackFile[];
      kind: "message";
      teamId: string;
      /** The raw text, as the person typed it. Empty when there is none. */
      text: string;
      /** Set when the message is a reply in a thread. */
      threadTs: string | undefined;
      trigger: MessageTrigger;
      ts: string;
      userId: string;
    }
  | {
      apiAppId: string | undefined;
      channelId: string;
      kind: "message_edited";
      teamId: string;
      text: string;
      ts: string;
    }
  | {
      apiAppId: string | undefined;
      channelId: string;
      kind: "message_deleted";
      teamId: string;
      ts: string;
    };

/**
 * Why the message reached the app: a DM, a mention, a reply in a thread, or
 * any other channel message, which the service stores but the app does not
 * answer.
 */
type MessageTrigger = "channel" | "dm" | "mention" | "thread";

/** What every real event carries: which Slack workspace, and which delivery. */
interface SlackEventContext {
  eventId: string;
  teamId: string;
}

type SlackFileInput = z.infer<typeof slackFileSchema>;

type MessageImEvent = z.infer<typeof messageImEventSchema>;

/** The fields a message and a mention share, for building a `message` event. */
interface IncomingMessage {
  channel: string;
  files?: SlackFileInput[] | null;
  text?: string | null;
  thread_ts?: string | null;
  ts: string;
}

/**
 * Read an events payload. Never throws, for the same reason `parseGateAction`
 * does not: the request has already been authenticated, so a shape nobody
 * expected is something to log and answer 200 to, not an exception.
 */
export function parseEvent(payload: unknown): SlackEvent {
  const challenge = urlVerificationSchema.safeParse(payload);
  if (challenge.success) {
    return { challenge: challenge.data.challenge, kind: "url_verification" };
  }
  const envelope = eventCallbackSchema.safeParse(payload);
  if (!envelope.success) {
    return { detail: issues(envelope.error), kind: "malformed" };
  }
  const context: SlackEventContext = {
    eventId: envelope.data.event_id,
    teamId: envelope.data.team_id,
  };
  const inner = envelope.data.event;
  const apiAppId = envelope.data.api_app_id;
  if (inner.type === "message") {
    return parseMessage(inner, context, apiAppId);
  }
  if (inner.type === "app_mention") {
    return parseAppMention(inner, context, apiAppId);
  }
  return { kind: "ignored", reason: "unsupported_event" };
}

/**
 * Subtypes the app still reads. A file shared with a comment is answered from
 * the comment: the files are read, and the person typed a command beside
 * them. A thread reply also sent to the channel is `thread_broadcast`, and is
 * still the person's message in that thread.
 */
const ANSWERED_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

/** The `channel_type` of a direct message. */
const DM_CHANNEL_TYPE = "im";

/**
 * A direct message, or a message in a channel. A channel message that is not
 * a thread reply is read as `channel`: the service stores it for the agent to
 * read later, and the app does not answer it. A mention in a channel also
 * arrives as `app_mention`, which the service handles. Edits and deletions are
 * read here, before the subtype filter that would drop them.
 */
function parseMessage(
  inner: unknown,
  context: SlackEventContext,
  apiAppId: string | undefined
): SlackEvent {
  const parsed = messageImEventSchema.safeParse(inner);
  if (!parsed.success) {
    return { detail: issues(parsed.error), kind: "malformed" };
  }
  const event = parsed.data;
  if (event.subtype === "message_changed") {
    return parseEdit(event, context, apiAppId);
  }
  if (event.subtype === "message_deleted") {
    return parseDelete(event, context, apiAppId);
  }
  const skipped = skipReason(event, apiAppId);
  if (skipped) {
    return { kind: "ignored", reason: skipped };
  }
  const userId = event.user;
  if (!userId) {
    return { kind: "ignored", reason: "no_sender" };
  }
  return toMessage(event, userId, context, apiAppId, messageTrigger(event));
}

/**
 * An edit names the edited message under `message`, and its `ts` is the
 * original message's ts. An edit of a bot's message, this app's own included,
 * is ignored as `bot_message`.
 */
function parseEdit(
  event: MessageImEvent,
  context: SlackEventContext,
  apiAppId: string | undefined
): SlackEvent {
  const edited = event.message;
  const ts = edited?.ts;
  if (!(edited && ts)) {
    return {
      detail: "message.ts: an edit names no message",
      kind: "malformed",
    };
  }
  const skipped = skipReason(edited, apiAppId);
  if (skipped) {
    return { kind: "ignored", reason: skipped };
  }
  return {
    apiAppId,
    channelId: event.channel,
    kind: "message_edited",
    teamId: context.teamId,
    text: edited.text ?? "",
    ts,
  };
}

/** A deletion names the removed message in `deleted_ts`. */
function parseDelete(
  event: MessageImEvent,
  context: SlackEventContext,
  apiAppId: string | undefined
): SlackEvent {
  const deletedTs = event.deleted_ts;
  if (!deletedTs) {
    return {
      detail: "deleted_ts: a deletion names no message",
      kind: "malformed",
    };
  }
  return {
    apiAppId,
    channelId: event.channel,
    kind: "message_deleted",
    teamId: context.teamId,
    ts: deletedTs,
  };
}

/**
 * A DM is `dm`. In a channel, a message is a `thread` reply when its
 * `thread_ts` names a different message (a thread's parent has `thread_ts`
 * equal to its own `ts`). Any other channel message is `channel`.
 */
function messageTrigger(event: {
  channel_type?: string | null;
  thread_ts?: string | null;
  ts: string;
}): MessageTrigger {
  if (event.channel_type === DM_CHANNEL_TYPE) {
    return "dm";
  }
  if (event.thread_ts && event.thread_ts !== event.ts) {
    return "thread";
  }
  return "channel";
}

/**
 * A mention in a channel, read like a DM: the same bot and subtype filtering,
 * and a mention with no sender is ignored rather than malformed, since only a
 * bot's message lacks one.
 */
function parseAppMention(
  inner: unknown,
  context: SlackEventContext,
  apiAppId: string | undefined
): SlackEvent {
  const parsed = appMentionEventSchema.safeParse(inner);
  if (!parsed.success) {
    return { detail: issues(parsed.error), kind: "malformed" };
  }
  const event = parsed.data;
  const skipped = skipReason(event, apiAppId);
  if (skipped) {
    return { kind: "ignored", reason: skipped };
  }
  const userId = event.user;
  if (!userId) {
    return { kind: "ignored", reason: "no_sender" };
  }
  return toMessage(event, userId, context, apiAppId, "mention");
}

function toMessage(
  event: IncomingMessage,
  userId: string,
  context: SlackEventContext,
  apiAppId: string | undefined,
  trigger: MessageTrigger
): SlackEvent {
  return {
    apiAppId,
    channelId: event.channel,
    eventId: context.eventId,
    files: toFiles(event.files),
    kind: "message",
    teamId: context.teamId,
    text: event.text ?? "",
    threadTs: event.thread_ts ?? undefined,
    trigger,
    ts: event.ts,
    userId,
  };
}

/**
 * Keeps the files the app can download. A tombstone is a file someone deleted,
 * and a file with no id or no download URL cannot be fetched, so both are
 * dropped. Missing name, type or size get the defaults below.
 */
function toFiles(files: SlackFileInput[] | null | undefined): SlackFile[] {
  return (files ?? []).flatMap((file) => {
    if (!(file.id && file.url_private_download) || file.mode === "tombstone") {
      return [];
    }
    return [
      {
        id: file.id,
        mimetype: file.mimetype ?? "application/octet-stream",
        name: file.name ?? "file",
        size: file.size ?? 0,
        url: file.url_private_download,
      },
    ];
  });
}

/**
 * Why a message or a mention is not for the app to answer: it came from a
 * bot (this app's own echo included), or it is an edit, a deletion or
 * another subtype the app does not read. Null when it is a person's.
 */
function skipReason(
  event: {
    app_id?: string | null;
    bot_id?: string | null;
    bot_profile?: unknown;
    subtype?: string | null;
  },
  apiAppId: string | undefined
): IgnoredReason | null {
  // A null `bot_profile` is not a bot: Slack sends null bot fields on a
  // person's message, and an echo that carries none of the three is still
  // stopped in the service, which drops anything sent by the app's own bot user.
  const fromThisApp = apiAppId !== undefined && event.app_id === apiAppId;
  if (
    event.bot_id ||
    (event.bot_profile !== undefined && event.bot_profile !== null) ||
    fromThisApp
  ) {
    return "bot_message";
  }
  if (event.subtype && !ANSWERED_SUBTYPES.has(event.subtype)) {
    return "message_subtype";
  }
  return null;
}

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
}
