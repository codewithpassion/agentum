/** Most characters of one room post that go to Slack. Slack advises staying under 4,000. */
export const OUTBOUND_TEXT_MAX = 3900;

const FALLBACK_NAME = "Someone";
const NAME_MAX = 80;
const ELLIPSIS = "…";

/** Escapes the three characters Slack reads as control syntax. */
const escapeSlack = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const WHITESPACE_RUN = /\s+/g;
/** A `<...` or `&...` the cut left open, which Slack would read as broken markup. */
const OPEN_TOKEN = /<[^>]*$|&[a-z]*$/;
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
  const cut = cutToLength(text, OUTBOUND_TEXT_MAX - ELLIPSIS.length).replace(
    OPEN_TOKEN,
    ""
  );
  return `${cut.trimEnd()}${ELLIPSIS}`;
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
  return cutForSlack(`*${escapeSlack(label)}:* ${text}`);
};

const FENCE_OR_CODE = /(```[\s\S]*?```|`[^`\n]+`)/;
const BULLET = /^([ \t]*)[-*+] +/gm;
const HEADING = /^#{1,6} +(.+?) *#*$/gm;
const QUOTE = /^&gt;/gm;
const LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
const ITALIC = /(?<![*\w])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?![*\w])/g;
const BOLD = /\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__/g;
const STRIKE = /~~(?=\S)(.+?)(?<=\S)~~/g;

const markdownToMrkdwn = (text: string): string =>
  escapeSlack(text)
    .replace(QUOTE, ">")
    .replace(BULLET, "$1• ")
    .replace(LINK, "<$2|$1>")
    .replace(ITALIC, "_$1_")
    .replace(
      BOLD,
      (_, stars: string | undefined, bars: string | undefined) =>
        `*${stars ?? bars}*`
    )
    .replace(STRIKE, "~$1~")
    .replace(HEADING, "*$1*");

/**
 * Turns the markdown of a room post into Slack's mrkdwn: bold, italics,
 * strikethrough, links, bullets and headings, with `&`, `<` and `>` escaped.
 * Code spans and fenced blocks keep their text and are only escaped.
 */
export const toSlackMrkdwn = (text: string): string =>
  text
    .split(FENCE_OR_CODE)
    .map((part, index) =>
      index % 2 === 1 ? escapeSlack(part) : markdownToMrkdwn(part)
    )
    .join("");
