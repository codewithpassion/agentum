/**
 * Slack's message markup ↔ our markdown. Pure and side-effect free: the names
 * behind `<@U…>` are resolved by the caller and passed in, so this stays a
 * function of its inputs.
 *
 * https://api.slack.com/reference/surfaces/formatting
 */

const USER_MENTION = /<@([A-Z0-9]+)(?:\|([^>]*))?>/g;
const CHANNEL_MENTION = /<#[A-Z0-9]+(?:\|([^>]*))?>/g;
const SPECIAL_MENTION = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
const LINK = /<((?:https?|mailto):[^|>]+)(?:\|([^>]*))?>/g;

export interface SlackTextContext {
  /** The agent the bot speaks as; `<@BOTID>` becomes `@thisName`. */
  agentName?: string | null;
  /** The bot's own Slack user id, from the event's `authorizations`. */
  botUserId?: string | null;
  /** Slack user id → display name, resolved before this runs. */
  userNames?: ReadonlyMap<string, string>;
}

/** Every `<@U…>` in the text, so the caller can look the names up in one pass. */
export const collectUserMentions = (text: string): string[] => [
  ...new Set([...text.matchAll(USER_MENTION)].map((match) => match[1] ?? "")),
];

const unescapeEntities = (text: string): string =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/**
 * Turns a Slack message into the body we store. The bot's own mention becomes
 * the bridged agent's `@Name`, which is what makes `parseMentions` - and so the
 * router - treat a Slack mention exactly like one typed in our UI.
 */
export const slackTextToBody = (
  text: string,
  context: SlackTextContext = {}
): string => {
  const { agentName, botUserId, userNames } = context;

  const withMentions = text.replace(USER_MENTION, (_match, id, label) => {
    if (botUserId && id === botUserId && agentName) {
      return `@${agentName}`;
    }
    const name = userNames?.get(id) ?? (typeof label === "string" ? label : "");
    return name ? `@${name}` : `@${id}`;
  });

  return unescapeEntities(
    withMentions
      .replace(CHANNEL_MENTION, (_match, label) =>
        label ? `#${label}` : "#channel"
      )
      .replace(SPECIAL_MENTION, (_match, name) => `@${name}`)
      .replace(LINK, (_match, url, label) => (label ? label : url))
  );
};

/**
 * The other direction. Slack only asks that these three characters be escaped;
 * our markdown is otherwise close enough to Slack's mrkdwn to send as-is.
 */
export const bodyToSlackText = (body: string): string =>
  body.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Mirrored posts all come from the same bot account, so the author's name is
 * carried in the text - otherwise Slack shows one bot talking to itself.
 */
export const mirroredText = (
  body: string,
  authorName: string | null
): string => {
  const text = bodyToSlackText(body);
  return authorName ? `*${authorName}*\n${text}` : text;
};
