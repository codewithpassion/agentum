import type { Payload } from "./payload.ts";

type PayloadValue = Payload[string];

const REDACTED = "[redacted]";

// Minimum body lengths for well-known token formats.
const SK_MIN = 16;
const GH_MIN = 30;
const GITHUB_PAT_MIN = 20;
const SLACK_MIN = 10;
const AWS_BODY_LENGTH = 16;
const JWT_HEADER = "eyJ";
const JWT_SEGMENT_MIN = 8;
const CREDENTIAL_MIN = 8;
const HM_MIN = 16;

// A credential name followed by `:` or `=`. The name matches as the tail of a
// key (`x-api-key`, `GITHUB_TOKEN`, `Set-Cookie`), so no name prefix is
// captured. The separator must follow the name directly, which keeps words
// such as "tokens", "token count" or "password reset" out of the match. Group
// 1 is the quote that closes a quoted key (`"token":`, `\"token\":`).
const CREDENTIAL_NAME =
  /(?:(?<![A-Za-z[])(?:authorization|cookie|token|secret|password|passwd|api[_-]?key)|(?<=[-_])key)(\\?["'])?[ \t]*[:=][ \t]*/gi;
// A bare auth scheme word followed by something shaped like a credential: at
// least 8 token characters, with at least one uppercase letter, digit or one of
// `_~+/=` (not a dot or hyphen, so prose such as "Basic authentication." stays
// as written).
const SCHEME_WORD = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(?:[Bb]earer|BEARER|[Bb]asic|BASIC|[Oo][Aa]uth|OAUTH|[Tt]oken|TOKEN)[ \t]+(?=[A-Za-z0-9._~+/=-]{${CREDENTIAL_MIN},})(?=[a-z.-]*[A-Z0-9_~+/=])`,
  "g"
);
const WORD_CHAR = /[\w-]/;
const PLACEHOLDERS = ["[redacted]", "[secret:"];

// Each pattern is anchored by a lookbehind so a run of token characters
// cannot restart a match at every position.
const WELL_KNOWN_TOKENS: readonly RegExp[] = [
  // sk-, sk-ant-, sk-or-
  new RegExp(`(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{${SK_MIN},}`, "g"),
  // hm_mach_, hm_run_, hm_enr_ and the other Harbourmaster credentials, with
  // the run token's `.signature` tail
  new RegExp(
    `(?<![A-Za-z0-9_])hm_[a-z]+_[A-Za-z0-9_-]{${HM_MIN},}(?:\\.[A-Za-z0-9_-]{${HM_MIN},})?`,
    "g"
  ),
  new RegExp(`(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{${GH_MIN},}`, "g"),
  new RegExp(
    `(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{${GITHUB_PAT_MIN},}`,
    "g"
  ),
  new RegExp(`(?<![A-Za-z0-9_-])xox[bpars]-[A-Za-z0-9-]{${SLACK_MIN},}`, "g"),
  new RegExp(
    `(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{${AWS_BODY_LENGTH}}(?![0-9A-Z])`,
    "g"
  ),
  new RegExp(
    String.raw`(?<![A-Za-z0-9_-])${JWT_HEADER}[A-Za-z0-9_-]{${JWT_SEGMENT_MIN - JWT_HEADER.length},}\.[A-Za-z0-9_-]{${JWT_SEGMENT_MIN},}(?:\.[A-Za-z0-9_-]+)?`,
    "g"
  ),
];

const isLineBreak = (char: string | undefined): boolean =>
  char === "\n" || char === "\r";

/** The quote that opens a value at `at`, `\\"` for an escaped one, or "". */
function openerAt(text: string, at: number): string {
  if (text.startsWith('\\"', at)) {
    return '\\"';
  }
  const char = text.charAt(at);
  return char === '"' || char === "'" ? char : "";
}

/** The quote that opens the string a key sits in, read from just before the key. */
function enclosingQuote(text: string, keyAt: number): string {
  let start = keyAt;
  while (start > 0 && WORD_CHAR.test(text.charAt(start - 1))) {
    start -= 1;
  }
  if (start >= 2 && text.startsWith('\\"', start - 2)) {
    return '\\"';
  }
  const char = text.charAt(start - 1);
  return char === '"' || char === "'" ? char : "";
}

interface Span {
  closed: boolean;
  end: number;
}

/** Where a value ends: at `quote` (not escaped) when one is given, else at the line end. */
function spanOf(text: string, from: number, quote: string): Span {
  for (let at = from; at < text.length; at += 1) {
    if (isLineBreak(text.charAt(at))) {
      return { closed: false, end: at };
    }
    if (
      quote !== "" &&
      text.startsWith(quote, at) &&
      (quote === '\\"' || text.charAt(at - 1) !== "\\")
    ) {
      return { closed: true, end: at };
    }
  }
  return { closed: false, end: text.length };
}

const isPlaceholder = (text: string, at: number): boolean =>
  PLACEHOLDERS.some((placeholder) => text.startsWith(placeholder, at));

/**
 * Replaces what follows each match of `pattern`, up to the end of the line. A
 * quoted value ends at its closing quote, and so does a value inside a string
 * the key opened (`-H "x-api-key: v"`), so the rest of that line stays. A
 * quote that never closes, or output cut off mid-value, runs to the line end.
 * The scan resumes after the replaced text, so the cost stays linear.
 */
function redactAfter(text: string, pattern: RegExp): string {
  let out = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const keyAt = match.index;
    const valueAt = keyAt + match[0].length;
    const opener = openerAt(text, valueAt);
    const inner = valueAt + opener.length;
    if (
      keyAt < cursor ||
      inner >= text.length ||
      isLineBreak(text.charAt(valueAt)) ||
      isPlaceholder(text, inner)
    ) {
      continue;
    }
    const closing = opener || (match[1] ? "" : enclosingQuote(text, keyAt));
    const span = spanOf(text, inner, closing);
    if (opener !== "" && span.closed && span.end === inner) {
      continue;
    }
    out += text.slice(cursor, inner) + REDACTED;
    if (opener !== "" && span.closed) {
      out += opener;
      cursor = span.end + opener.length;
    } else {
      cursor = span.end;
    }
  }
  return out + text.slice(cursor);
}

export function redactText(text: string): string {
  let result = redactAfter(text, CREDENTIAL_NAME);
  result = redactAfter(result, SCHEME_WORD);
  for (const pattern of WELL_KNOWN_TOKENS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

function redactValue(value: PayloadValue): PayloadValue {
  if (typeof value === "string") {
    return redactText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item)])
    );
  }
  return value;
}

export function redactToolPayload(payload: Payload): Payload {
  return Object.fromEntries(
    Object.entries(payload).map(([key, value]) => [key, redactValue(value)])
  );
}
