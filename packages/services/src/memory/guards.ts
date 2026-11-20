import { NAMESPACE_PATTERN } from "@repo/protocol/token-prefixes";

/** A named pattern for a secret that must not reach memory. */
export const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  {
    name: "PEM private key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  },
  {
    name: "AWS access key id",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    name: "GitHub token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/,
  },
  {
    name: "Slack token",
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  },
  {
    name: "Stripe key",
    pattern: /\b(?:sk_live_|sk_test_|rk_live_)[A-Za-z0-9]{16,}/,
  },
  {
    name: "sk- API key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}/,
  },
  {
    name: "Google API key",
    pattern: /\bAIza[A-Za-z0-9_-]{35}/,
  },
  {
    name: "JSON web token",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  },
  {
    name: "Agentum token",
    pattern: new RegExp(
      `\\b${NAMESPACE_PATTERN}[a-z][a-z0-9]*_[A-Za-z0-9_-]{20,}`
    ),
  },
  {
    name: "Bearer token",
    pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{20,}/i,
  },
  {
    name: "password assignment",
    pattern: /(?:password|passwd|pwd|passphrase)(?:\s+is\s+|\s*[=:]\s*)\S{4,}/i,
  },
  {
    name: "secret assignment",
    pattern:
      /(?:api[ _]?key|secret|token|access[ _]?key)(?:\s+is\s+|\s*[=:]\s*)[A-Za-z0-9_\-./+=]{12,}/i,
  },
];

// Matches a run of 13 to 19 digits, with at most one space or dash between
// digits. matchAll copies the regex, so the g flag keeps no state between calls.
const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;

const luhn = (digits: string): boolean => {
  let sum = 0;
  let double = false;
  for (const char of [...digits].reverse()) {
    let digit = Number(char);
    if (double) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};

const hasCardNumber = (text: string): boolean => {
  for (const [candidate] of text.matchAll(CARD_CANDIDATE)) {
    const digits = candidate.replaceAll(" ", "").replaceAll("-", "");
    if (luhn(digits)) {
      return true;
    }
  }
  return false;
};

/** The name of the first secret pattern `text` matches, or null. */
export const findSecret = (text: string): string | null => {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      return name;
    }
  }
  return hasCardNumber(text) ? "card number" : null;
};

export type OutsideSource = "mail" | "web" | "peer";

/** Why a note's only source is outside text, or null for internal origins. */
export const outsideSourceOf = (info: {
  origin: string | null;
  peer: boolean;
  web: boolean;
}): OutsideSource | null => {
  if (info.peer || info.origin === "a2a") {
    return "peer";
  }
  if (info.origin === "mail") {
    return "mail";
  }
  if (info.web) {
    return "web";
  }
  return null;
};
