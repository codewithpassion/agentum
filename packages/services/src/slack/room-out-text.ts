/** Most characters of one room post that go to Slack. Slack advises staying under 4,000. */
export const OUTBOUND_TEXT_MAX = 3900;

const FALLBACK_NAME = "Someone";
const NAME_MAX = 80;
const ELLIPSIS = "…";

const WHITESPACE_RUN = /\s+/g;
const NAME_MARKUP = /[*_~`]/g;

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

/** The text cut to what one Slack message takes, with an ellipsis when it was cut. */
export const cutForSlack = (text: string): string => {
  if (text.length <= OUTBOUND_TEXT_MAX) {
    return text;
  }
  return `${cutToLength(text, OUTBOUND_TEXT_MAX - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
};

/**
 * The line a room post goes out as when the Slack app that sends it is not the
 * author's own: the author's name in bold, then the text. The name loses line
 * breaks and Slack markup characters, so it cannot change the look of the text.
 */
export const speakerLine = (
  name: string | null | undefined,
  text: string
): string => {
  const label =
    cutToLength(
      (name ?? "").replace(NAME_MARKUP, "").replace(WHITESPACE_RUN, " ").trim(),
      NAME_MAX
    ).trimEnd() || FALLBACK_NAME;
  return cutForSlack(`*${label}:* ${text}`);
};
