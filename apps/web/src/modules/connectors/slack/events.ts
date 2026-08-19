import { z } from "zod";

/**
 * Only the slice of the Events API we act on. Parsing (rather than casting)
 * untrusted webhook JSON is the point: everything downstream is typed, and an
 * unexpected payload becomes `null` instead of a runtime surprise.
 *
 * https://api.slack.com/apis/events-api
 */

export const slackFileSchema = z.object({
  id: z.string(),
  mimetype: z.string().optional(),
  name: z.string().optional(),
  size: z.number().optional(),
  url_private: z.string().optional(),
});

export const slackMessageEventSchema = z.object({
  bot_id: z.string().optional(),
  channel: z.string().optional(),
  /** `im` for DMs with the bot, `channel` for public channels. */
  channel_type: z.string().optional(),
  files: z.array(slackFileSchema).optional(),
  /** Present on edits, joins, bot posts… - we only take subtype-less messages. */
  subtype: z.string().optional(),
  text: z.string().optional(),
  thread_ts: z.string().optional(),
  ts: z.string().optional(),
  type: z.string(),
  user: z.string().optional(),
});

export const slackEventCallbackSchema = z.object({
  /** The installed bot's own user id, used to translate `<@BOTID>` mentions. */
  authorizations: z
    .array(z.object({ user_id: z.string().optional() }))
    .optional(),
  event: slackMessageEventSchema,
  event_id: z.string(),
  team_id: z.string().optional(),
  type: z.literal("event_callback"),
});

export const slackUrlVerificationSchema = z.object({
  challenge: z.string(),
  type: z.literal("url_verification"),
});

export const slackEnvelopeSchema = z.union([
  slackUrlVerificationSchema,
  slackEventCallbackSchema,
]);

export type SlackFile = z.infer<typeof slackFileSchema>;
export type SlackMessageEvent = z.infer<typeof slackMessageEventSchema>;
export type SlackEventCallback = z.infer<typeof slackEventCallbackSchema>;
export type SlackEnvelope = z.infer<typeof slackEnvelopeSchema>;

/** `null` for anything we do not handle - Slack still gets its 200. */
export const parseSlackEnvelope = (raw: unknown): SlackEnvelope | null => {
  const parsed = slackEnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

/** Slack channel ids: `C`/`G` for channels and groups, `D` for IMs. */
const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{6,}$/;

export const isSlackChannelId = (value: string): boolean =>
  CHANNEL_ID_PATTERN.test(value);

/** A `ts` is only unique within a channel, so the pair is the message identity. */
export const slackMessageKey = (channelId: string, ts: string): string =>
  `${channelId}:${ts}`;

export const slackMessageTs = (key: string): string =>
  key.slice(key.indexOf(":") + 1);
