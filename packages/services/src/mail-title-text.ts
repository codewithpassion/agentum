/**
 * The title text of a run that may have started by mail. Pure, so the browser
 * can import it (the task receipt does); the database read is in `mail-subjects.ts`.
 */
import { stripAttachmentMarkers } from "@repo/protocol/attachments";
import { mailTitle } from "./rail/logic.ts";

/** The first words of the notice a run started by mail begins with. */
const INBOUND_MAIL_PREFIX = "Inbound mail.";

/** The title of a run started by mail that has no subject to show. */
const INBOUND_MAIL_TITLE = "Inbound mail";

/** The mail subject a run is titled by, without its leading Re:, Fwd: or Fw:. Undefined when there is none. */
export const mailTitleOf = (
  subject: string | undefined
): string | undefined => {
  const title = subject === undefined ? "" : mailTitle(subject);
  return title === "" ? undefined : title;
};

/** Maximum displayed title length, including the ellipsis. */
export const TITLE_MAX = 80;

const ENVELOPE_PREFIX_RE = /^\{\s*"harbourmaster_turn"/;
const LINE_RE = /\r?\n/;
const WHITESPACE_RE = /\s+/g;
/** The start of JSON that may have been cut short, as the TH.1 backfill did at 60 characters. */
const JSON_START_RE = /^(\{\s*"|\[\s*[[{"])/;
const MARKUP_RE = /<\/?[a-z][^>]*>|<!--|<\?|<!doctype/i;

/** JSON, or the start of JSON cut short (a truncated envelope, or the 60 character cut of the TH.1 backfill). */
export const isJsonTitle = (raw: string): boolean => {
  const text = raw.trim();
  if (ENVELOPE_PREFIX_RE.test(text) || JSON_START_RE.test(text)) {
    return true;
  }
  if (!(text.startsWith("{") || text.startsWith("["))) {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

/**
 * Display text only: accept old/incomplete speaker metadata, never JSON or markup.
 * Stored names disable unwrapping: a JSON envelope is not a person's title.
 */
export const readableTitle = (
  raw: string,
  unwrapEnvelope = true
): string | undefined => {
  let text = raw.trim();
  if (unwrapEnvelope && text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed?.harbourmaster_turn?.text === "string") {
        ({ text } = parsed.harbourmaster_turn);
      }
    } catch {
      // A truncated envelope is rejected below rather than displayed as JSON.
    }
  }
  text = stripAttachmentMarkers(text).trim();
  // Check the whole input before taking a line, so pretty-printed JSON is rejected.
  if (isJsonTitle(text) || (text.startsWith("<") && MARKUP_RE.test(text))) {
    return;
  }
  text = (text.split(LINE_RE).find((line) => line.trim() !== "") ?? "")
    .replace(WHITESPACE_RE, " ")
    .trim();
  if (
    !text ||
    isJsonTitle(text) ||
    (text.startsWith("<") && MARKUP_RE.test(text))
  ) {
    return;
  }
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 3)}...` : text;
};

/** Whether a person's own title holds no JSON, marker or markup anywhere, not only at the start. */
export const isPlainTitle = (name: string): boolean =>
  readableTitle(name, false) !== undefined &&
  stripAttachmentMarkers(name) === name &&
  !MARKUP_RE.test(name);

/** A stored title when it is still readable: the one check every read path shares. */
export const storedTitle = (title: string | null): string | undefined =>
  title !== null && readableTitle(title, false) !== undefined
    ? title
    : undefined;

/** Shared by session reads and the one-off repair, including unnamed agents. */
export const conversationTitle = (
  input: string,
  agentName?: string | null
): string => {
  const title = readableTitle(input);
  if (title?.startsWith(INBOUND_MAIL_PREFIX)) {
    return INBOUND_MAIL_TITLE;
  }
  const agent = readableTitle(agentName ?? "", false);
  return (
    title ??
    readableTitle(agent ? `Conversation with ${agent}` : "Conversation") ??
    "Conversation"
  );
};

/**
 * The text a run is titled by: its mail subject when it has one, else its input
 * text. A run started by mail with no subject reads "Inbound mail", never its notice.
 */
export const runTitleText = (inputText: string, subject?: string): string => {
  const title = mailTitleOf(subject);
  if (title !== undefined) {
    return readableTitle(title, false) ?? "Conversation";
  }
  const spoken = readableTitle(inputText);
  return spoken?.startsWith(INBOUND_MAIL_PREFIX)
    ? INBOUND_MAIL_TITLE
    : (spoken ?? "Conversation");
};

/**
 * What the task receipt shows for a run's first step: the whole input, or the
 * first line of what an envelope says, never the wrapper. Not cut to a title.
 */
export const runInputText = (inputText: string): string => {
  if (ENVELOPE_PREFIX_RE.test(inputText.trim())) {
    try {
      const parsed = JSON.parse(inputText);
      if (typeof parsed?.harbourmaster_turn?.text === "string") {
        return parsed.harbourmaster_turn.text.split(LINE_RE)[0] ?? "";
      }
    } catch {
      return inputText;
    }
  }
  return inputText.startsWith(INBOUND_MAIL_PREFIX)
    ? INBOUND_MAIL_TITLE
    : inputText;
};
