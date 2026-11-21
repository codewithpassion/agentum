/** Longest title a room post takes from a message, counted in characters. */
export const TOPIC_TITLE_MAX = 120;

const FALLBACK_TITLE = "Slack message";
const FALLBACK_GUEST_LABEL = "Someone";
const GUEST_LABEL_MAX = 80;
const ELLIPSIS = "…";

const LINE_BREAK = /\r\n|\r|\n/;
const WHITESPACE_RUN = /\s+/g;

/**
 * A Slack user mention, `<@U123>` or `<@U123|name>`. The id is captured. The
 * name part, when present, is ignored.
 */
const USER_MENTION = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;

const collapseWhitespace = (text: string): string =>
  text.replace(WHITESPACE_RUN, " ").trim();

/** The longest prefix of `text` that holds at most `maxLength` UTF-16 units, without splitting a character. */
const cutToLength = (text: string, maxLength: number): string => {
  let cut = "";
  for (const character of text) {
    if (cut.length + character.length > maxLength) {
      break;
    }
    cut += character;
  }
  return cut;
};

/** A one-line title from the first non-blank line of a Slack message. */
export const topicTitle = (text: string): string => {
  const firstLine = text
    .split(LINE_BREAK)
    .map(collapseWhitespace)
    .find((line) => line !== "");
  if (firstLine === undefined) {
    return FALLBACK_TITLE;
  }
  if (firstLine.length <= TOPIC_TITLE_MAX) {
    return firstLine;
  }
  const kept = cutToLength(firstLine, TOPIC_TITLE_MAX - ELLIPSIS.length);
  return `${kept.trimEnd()}${ELLIPSIS}`;
};

/** The distinct Slack user ids mentioned in `text`, in order of first appearance. */
export const slackMentionedUserIds = (text: string): string[] => {
  const ids = new Set<string>();
  for (const match of text.matchAll(USER_MENTION)) {
    const [, id = ""] = match;
    ids.add(id);
  }
  return [...ids];
};

/**
 * Replaces the mention of each bot user in `agentSlugs` with `@slug`. Every
 * other mention and all surrounding whitespace stay as they are.
 */
export const convertAgentMentions = (
  text: string,
  agentSlugs: ReadonlyMap<string, string>
): string =>
  text.replace(USER_MENTION, (mention: string, id: string): string => {
    const slug = agentSlugs.get(id);
    return slug === undefined ? mention : `@${slug}`;
  });

/** The name a Slack guest's post is shown with: their profile name, trimmed to a line, or "Someone". */
export const guestName = (name: string): string =>
  cutToLength(collapseWhitespace(name), GUEST_LABEL_MAX).trimEnd() ||
  FALLBACK_GUEST_LABEL;
