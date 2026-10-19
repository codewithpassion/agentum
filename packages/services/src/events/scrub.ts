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
const BEARER_MIN = 8;

// Credential fields. Names match as the tail of a key, so no name prefix is
// captured. The separator must follow the name directly, which keeps words
// such as "tokens", "token count" or "password reset" out of the match.
const SEPARATOR = String.raw`(?:\\?["'])?[ \t]*[:=][ \t]*`;
// Auth schemes whose word stays in the text. After any other first word, the
// whole rest of the value is the credential, so a raw key is never mistaken
// for a scheme.
const SCHEME = String.raw`(?:bearer|basic|token|bot|apikey|api-key|key|ssws|negotiate|ntlm|oauth|jwt)[ \t]+`;
const SCHEME_PREFIX = new RegExp(`^${SCHEME}`, "i");
const SKIP_REDACTED = String.raw`(?!(?:\\?["'])?(?:${SCHEME})?\[(?:redacted\]|secret:))`;
// A value in quotes, or in escaped quotes as inside a JSON body in a shell string.
const QUOTED = String.raw`\\"(?!\\")[^\r\n]+?\\"|"[^"\r\n]+"|'[^'\r\n]+'`;
const UNQUOTED = String.raw`[^\s"',;&})\]]+`;
const FIELD_VALUE = `(?:${QUOTED}|${UNQUOTED})`;
const REST_OF_LINE = String.raw`(?:${QUOTED}|[^\r\n"' \t][^\r\n"']*)`;
const AUTH_VALUE = `(?:${SCHEME}${UNQUOTED}|${REST_OF_LINE})`;
const COOKIE_VALUE = REST_OF_LINE;

const AUTH_HEADER = new RegExp(
  `(authorization${SEPARATOR})${SKIP_REDACTED}(${AUTH_VALUE})`,
  "gi"
);
const COOKIE_HEADER = new RegExp(
  `(cookie${SEPARATOR})${SKIP_REDACTED}(${COOKIE_VALUE})`,
  "gi"
);
const CREDENTIAL_FIELD = new RegExp(
  String.raw`((?<!\[)(?:token|secret(?:[_-]?access)?(?:[_-]?key)?|password|passwd|api[_-]?key)${SEPARATOR})${SKIP_REDACTED}(${FIELD_VALUE})`,
  "gi"
);
const BEARER_TOKEN = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])(Bearer[ \t]+)[A-Za-z0-9._~+/=-]{${BEARER_MIN},}`,
  "g"
);

// Each pattern is anchored by a lookbehind so a run of token characters
// cannot restart a match at every position.
const WELL_KNOWN_TOKENS: readonly RegExp[] = [
  // sk-, sk-ant-, sk-or-
  new RegExp(`(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{${SK_MIN},}`, "g"),
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

// Keeps the quotes and an auth scheme word, and replaces the rest of the value.
function maskValue(value: string, keepScheme: boolean): string {
  let quote = "";
  if (value.startsWith('\\"')) {
    quote = '\\"';
  } else if (value.startsWith('"') || value.startsWith("'")) {
    quote = value.charAt(0);
  }
  const inner = quote ? value.slice(quote.length, -quote.length) : value;
  const scheme = keepScheme ? (inner.match(SCHEME_PREFIX)?.[0] ?? "") : "";
  return `${quote}${scheme}${REDACTED}${quote}`;
}

export function redactText(text: string): string {
  const scrubbed = text
    .replace(
      AUTH_HEADER,
      (_match: string, prefix: string, value: string) =>
        `${prefix}${maskValue(value, true)}`
    )
    .replace(
      COOKIE_HEADER,
      (_match: string, prefix: string, value: string) =>
        `${prefix}${maskValue(value, false)}`
    )
    .replace(
      CREDENTIAL_FIELD,
      (_match: string, prefix: string, value: string) =>
        `${prefix}${maskValue(value, false)}`
    )
    .replace(BEARER_TOKEN, `$1${REDACTED}`);
  let result = scrubbed;
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
