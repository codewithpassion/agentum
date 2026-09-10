/**
 * Signed, time-limited links to exactly one attachment, for handing a file to
 * an external service that has to fetch it itself - a transcription API given
 * an mp3 is the case this exists for. Every other read path in the product is
 * behind a session, so the rules here are deliberately the narrowest thing that
 * works: one HMAC over one attachment id and one expiry, nothing that can be
 * widened after the fact, and no listing of any kind.
 *
 * `ATTACHMENT_LINK_KEY` (base64, 32 bytes) keys HMAC-SHA256 through WebCrypto -
 * the same shape and generation as `CONNECTOR_KEY`, which is why the error
 * wording below reads the same. Its absence disables minting rather than
 * degrading to an unsigned URL: a deployment that never had a key can never
 * have issued a link, so its reader is free to refuse every request.
 *
 * The signature covers the expiry as well as the id. Signing the id alone would
 * hand out a bearer token for that file forever, since the expiry travels in
 * the query string where the holder can edit it.
 */

const KEY_BYTES = 32;
const HMAC = { hash: "SHA-256", name: "HMAC" } as const;
const MILLISECONDS_PER_SECOND = 1000;

/** Long enough for a third party to fetch the file, short enough to not matter if it leaks. */
export const DEFAULT_LINK_TTL_SECONDS = 15 * 60;
export const MAX_LINK_TTL_SECONDS = 60 * 60;
const MIN_LINK_TTL_SECONDS = 1;

/** Where `routes/attachment-links.ts` is mounted, so the URL builder and the router agree. */
export const ATTACHMENT_LINK_BASE_PATH = "/api/attachment-links";

/**
 * An expiry is unix *seconds* and nothing else. That is what makes the signed
 * message unambiguous: `id:exp` can only be split one way when `exp` is a plain
 * digit string, so no id can borrow digits from the expiry and still verify.
 */
const EXPIRY_DIGITS = /^\d{1,15}$/;
const BASE64_PADDING = /[=]+$/;
const BASE64URL_MINUS = /-/g;
const BASE64URL_UNDERSCORE = /_/g;
const BASE64_PLUS = /\+/g;
const BASE64_SLASH = /\//g;

const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** Signatures ride in a query string, so they are base64url and unpadded. */
const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(BASE64_PLUS, "-")
    .replace(BASE64_SLASH, "_")
    .replace(BASE64_PADDING, "");
};

/** Throws on anything that is not base64url; every caller treats that as "no". */
const decodeBase64Url = (value: string): Uint8Array<ArrayBuffer> => {
  const padded = value
    .replace(BASE64URL_MINUS, "+")
    .replace(BASE64URL_UNDERSCORE, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return decodeBase64(padded);
};

/**
 * A missing key is a deployment fault with a fix, not a reason to fall back to
 * an unsigned URL - so it reads like the one `CONNECTOR_KEY` gives.
 */
const requireKey = (key: string | null | undefined): string => {
  if (!key) {
    throw new Error(
      "ATTACHMENT_LINK_KEY is not configured. Set it (a base64 32-byte key) before minting attachment links."
    );
  }
  return key;
};

const importKey = async (key: string): Promise<CryptoKey> => {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = decodeBase64(key);
  } catch (error) {
    throw new Error("ATTACHMENT_LINK_KEY is not valid base64.", {
      cause: error,
    });
  }
  if (raw.length !== KEY_BYTES) {
    throw new Error(
      `ATTACHMENT_LINK_KEY must decode to ${KEY_BYTES} bytes, got ${raw.length}.`
    );
  }
  return await crypto.subtle.importKey("raw", raw, HMAC, false, [
    "sign",
    "verify",
  ]);
};

const messageFor = (id: string, expiry: string): Uint8Array<ArrayBuffer> =>
  new TextEncoder().encode(`attachment-link.v1:${id}:${expiry}`);

/**
 * A ttl the agent asked for, made safe: out of range or absent becomes the
 * default, and nothing gets past the cap. Clamping rather than failing keeps a
 * model's guess at "an hour or so" from turning into an error it has to recover
 * from, while still bounding how long the link lives.
 */
export const clampLinkTtl = (ttlSeconds: number | undefined): number => {
  if (
    ttlSeconds === undefined ||
    !Number.isFinite(ttlSeconds) ||
    ttlSeconds < MIN_LINK_TTL_SECONDS
  ) {
    return DEFAULT_LINK_TTL_SECONDS;
  }
  return Math.min(Math.floor(ttlSeconds), MAX_LINK_TTL_SECONDS);
};

export interface AttachmentLink {
  /** Unix seconds, and signed - so the holder cannot move it. */
  expiresAt: number;
  id: string;
  signature: string;
}

export const signAttachmentLink = async (
  key: string | null | undefined,
  input: { id: string; now?: number; ttlSeconds?: number }
): Promise<AttachmentLink> => {
  const now = input.now ?? Date.now();
  const expiresAt =
    Math.floor(now / MILLISECONDS_PER_SECOND) + clampLinkTtl(input.ttlSeconds);
  const signature = await crypto.subtle.sign(
    HMAC,
    await importKey(requireKey(key)),
    messageFor(input.id, String(expiresAt))
  );
  return {
    expiresAt,
    id: input.id,
    signature: encodeBase64Url(new Uint8Array(signature)),
  };
};

/**
 * Total by design: every way a request can be wrong - no key, no `exp`, no
 * `sig`, an expiry that is not a plain integer, an expiry in the past, a
 * signature that is not base64url, a signature over some other id or some other
 * expiry - answers `false` and nothing else. The comparison itself is
 * `crypto.subtle.verify`, which is constant-time by construction; comparing the
 * two base64 strings ourselves would leak the correct prefix a byte at a time.
 *
 * A key that is present but malformed still throws. That is a deployment fault
 * that holds for every request rather than a property of any one attachment, so
 * it is not something an attacker can learn an id from.
 */
export const verifyAttachmentLink = async (
  key: string | null | undefined,
  input: {
    exp: string | undefined | null;
    id: string;
    now?: number;
    sig: string | undefined | null;
  }
): Promise<boolean> => {
  const { exp, sig } = input;
  if (!(key && exp && sig)) {
    return false;
  }
  if (!EXPIRY_DIGITS.test(exp)) {
    return false;
  }

  const expiresAt = Number(exp);
  const now = input.now ?? Date.now();
  if (expiresAt * MILLISECONDS_PER_SECOND <= now) {
    return false;
  }

  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = decodeBase64Url(sig);
  } catch {
    return false;
  }
  return await crypto.subtle.verify(
    HMAC,
    await importKey(key),
    signature,
    messageFor(input.id, exp)
  );
};

/** The path half of a link; the tool resolves it against the public origin. */
export const attachmentLinkPath = (link: AttachmentLink): string =>
  `${ATTACHMENT_LINK_BASE_PATH}/${encodeURIComponent(link.id)}?exp=${link.expiresAt}&sig=${encodeURIComponent(link.signature)}`;
