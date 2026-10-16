/**
 * Slack request signing, version `v0`.
 *
 * Slack signs every request to the interactivity URL with an HMAC-SHA256 over
 * `v0:<timestamp>:<raw body>` keyed by the app's signing secret, and sends the
 * result as `x-slack-signature` alongside `x-slack-request-timestamp`. Anyone
 * who can reach the URL can post to it, so this check is the only thing that
 * makes an interaction payload trustworthy: run it before the payload is
 * parsed, over the body bytes exactly as they arrived.
 *
 * Web Crypto only, no `node:crypto`: the control plane is a Cloudflare Worker
 * (`docs/vocabulary.md`).
 */

/** Slack's replay window. A request older (or newer) than this is refused. */
const MAX_AGE_SECONDS = 60 * 5;
const MILLISECONDS_PER_SECOND = 1000;

/** Seconds since the epoch, as Slack sends them. */
const TIMESTAMP_PATTERN = /^\d{1,15}$/;
/** `v0=` and 32 bytes of lowercase hex. */
const SIGNATURE_PATTERN = /^v0=[0-9a-f]{64}$/;

export interface VerifySlackRequestInput {
  /** The raw request body, byte for byte as Slack sent it. */
  body: string;
  /** Milliseconds since the epoch. Defaults to `Date.now()`. */
  now?: number;
  /** The `x-slack-signature` header. */
  signature: string;
  /** The app's signing secret. */
  signingSecret: string;
  /** The `x-slack-request-timestamp` header, in seconds. */
  timestamp: string;
}

/**
 * True when the request really came from Slack and is inside the replay
 * window. False for anything else, including a malformed header: there is
 * nothing a caller can do with the difference except log it, and returning a
 * reason invites a caller to act on a request it has not authenticated.
 */
export async function verifySlackRequest(
  input: VerifySlackRequestInput
): Promise<boolean> {
  const { body, now = Date.now(), signature, signingSecret, timestamp } = input;
  if (
    !(TIMESTAMP_PATTERN.test(timestamp) && SIGNATURE_PATTERN.test(signature))
  ) {
    return false;
  }
  const ageSeconds = Math.abs(
    now / MILLISECONDS_PER_SECOND - Number(timestamp)
  );
  if (ageSeconds > MAX_AGE_SECONDS) {
    return false;
  }
  const expected = await signSlackBody({ body, signingSecret, timestamp });
  return constantTimeEquals(expected, signature);
}

export interface SignSlackBodyInput {
  /** The raw request body, byte for byte as it will be sent. */
  body: string;
  /** The app's signing secret. */
  signingSecret: string;
  /** The `x-slack-request-timestamp` value, in seconds. */
  timestamp: string;
}

/**
 * The `x-slack-signature` value for a body: `v0=` plus the lowercase hex
 * HMAC-SHA256 of `v0:<timestamp>:<body>` under the signing secret.
 */
export async function signSlackBody(
  input: SignSlackBodyInput
): Promise<string> {
  const { body, signingSecret, timestamp } = input;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`v0:${timestamp}:${body}`)
  );
  return `v0=${toHex(new Uint8Array(digest))}`;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Byte comparison that does not stop at the first difference, so the time it
 * takes says nothing about how much of a forged signature was right. The
 * length check leaks only the length, which is fixed for a `v0` signature.
 */
function constantTimeEquals(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (const [index, byte] of a.entries()) {
    // biome-ignore lint/suspicious/noBitwiseOperators: a constant-time compare is exactly what bitwise accumulation is for; a boolean short-circuits.
    mismatch |= byte ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}
