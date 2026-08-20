/**
 * Slack request signing (v0). Every delivery - including the one-off
 * `url_verification` handshake - carries `X-Slack-Signature` over the raw body,
 * so this runs before the body is parsed and before anything is trusted.
 *
 * https://api.slack.com/authentication/verifying-requests-from-slack
 */

const HEX_RADIX = 16;
const BYTE_HEX_LENGTH = 2;
const SIGNATURE_VERSION = "v0";
/** Slack's own recommendation: anything older is a replay. */
export const REPLAY_WINDOW_SECONDS = 60 * 5;
const MILLISECONDS = 1000;

export interface SlackSignatureHeaders {
  signature: string | null | undefined;
  timestamp: string | null | undefined;
}

export const readSignatureHeaders = (
  headers: Headers
): SlackSignatureHeaders => ({
  signature: headers.get("x-slack-signature"),
  timestamp: headers.get("x-slack-request-timestamp"),
});

const toHex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(HEX_RADIX).padStart(BYTE_HEX_LENGTH, "0"))
    .join("");

/** Constant-time: the expected signature must not leak through timing. */
const equals = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (const [index, character] of [...a].entries()) {
    difference += character === b[index] ? 0 : 1;
  }
  return difference === 0;
};

export const signSlackRequest = async (
  signingSecret: string,
  timestamp: string,
  rawBody: string
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${SIGNATURE_VERSION}:${timestamp}:${rawBody}`)
  );
  return `${SIGNATURE_VERSION}=${toHex(signature)}`;
};

export type SignatureFailure = "invalid" | "malformed" | "stale";

export type SignatureResult =
  | { valid: true }
  | { valid: false; reason: SignatureFailure };

/**
 * `now` is injected so the replay window is testable and so a clock skew fix
 * never has to reach into this function.
 */
export const verifySlackSignature = async (input: {
  headers: SlackSignatureHeaders;
  now?: Date;
  rawBody: string;
  signingSecret: string;
}): Promise<SignatureResult> => {
  const { headers, rawBody, signingSecret } = input;
  if (!(headers.signature && headers.timestamp)) {
    return { reason: "malformed", valid: false };
  }

  const timestamp = Number.parseInt(headers.timestamp, 10);
  if (!Number.isFinite(timestamp)) {
    return { reason: "malformed", valid: false };
  }

  const nowSeconds = (input.now?.getTime() ?? Date.now()) / MILLISECONDS;
  if (Math.abs(nowSeconds - timestamp) > REPLAY_WINDOW_SECONDS) {
    return { reason: "stale", valid: false };
  }

  const expected = await signSlackRequest(
    signingSecret,
    headers.timestamp,
    rawBody
  );
  return equals(expected, headers.signature)
    ? { valid: true }
    : { reason: "invalid", valid: false };
};
