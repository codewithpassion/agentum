/**
 * Secrets at rest: AES-GCM 256 under one Worker secret, `SECRETS_KEY`
 * (32 random bytes, base64). Also the random tokens a table stores only as
 * a hash. Pure Web Crypto, so it runs in workerd and in bun alike.
 *
 * Stored form: `v1:<base64url iv>:<base64url ciphertext>`, a fresh 12-byte IV
 * per value. The additional authenticated data is the JSON array of the
 * workspace, table, row and field ids, so a ciphertext copied into another
 * row, table or field fails to decrypt instead of handing over a credential.
 * The `v1` prefix leaves room for a change of format.
 *
 * Rotation: a key spec is one base64 key, or `current,previous`
 * (`keySpec(SECRETS_KEY, SECRETS_KEY_PREVIOUS)`). `importSecretsKey` returns
 * the current key, and `decryptSecret` falls back to the previous one when the
 * current one fails. `encryptSecret` always uses the current key.
 *
 * Errors are CryptoErrors that never carry plaintext, ciphertext or key bytes.
 */

import type { TokenPrefix } from "@repo/protocol/token-prefixes";

/** What a stored secret is bound to: its workspace, table, row and column. */
export interface SecretBinding {
  field: string;
  rowId: string;
  table: string;
  workspaceId: string;
}

export class CryptoError extends Error {
  readonly code = "unavailable" as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CryptoError";
  }
}

export const isCryptoError = (e: unknown): e is CryptoError =>
  e instanceof CryptoError;

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TOKEN_BYTES = 32;
const ALGORITHM = "AES-GCM";

const INVALID_KEY = "SECRETS_KEY must be 32 random bytes, base64 encoded.";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const TRAILING_PADDING = /[=]+$/;

/** Base64url without padding. */
export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(TRAILING_PADDING, "");
};

/** Null when `text` is not base64url. */
export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | null => {
  if (!BASE64URL.test(text)) {
    return null;
  }
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
};

/** Equal byte strings, with no early return once the lengths match. */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: XOR accumulation is what keeps the comparison constant time
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
};

const additionalData = (binding: SecretBinding) =>
  encoder.encode(
    JSON.stringify([
      binding.workspaceId,
      binding.table,
      binding.rowId,
      binding.field,
    ])
  );

const unreadable = (binding: SecretBinding, cause?: unknown) =>
  new CryptoError(`The stored ${binding.field} cannot be read.`, { cause });

const KEY_SEPARATOR = ",";

/** `current`, or `current,previous` when a previous key is set. Standard base64 has no comma. */
export const keySpec = (current: string, previous?: string): string =>
  previous?.trim()
    ? `${current.trim()}${KEY_SEPARATOR}${previous.trim()}`
    : current;

/** The two keys of a spec. `previous` is undefined when the spec has one key. */
export const splitKeySpec = (
  spec: string
): { current: string; previous: string | undefined } => {
  const [current = "", previous] = spec.split(KEY_SEPARATOR);
  return { current, previous: previous?.trim() ? previous : undefined };
};

/** The key a stored value falls back to, by the current key that carries it. */
const previousKeys = new WeakMap<CryptoKey, CryptoKey>();

const importAesKey = async (
  base64: string,
  name: string
): Promise<CryptoKey> => {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(base64.trim());
    raw = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch (error: unknown) {
    throw new CryptoError(INVALID_KEY.replace("SECRETS_KEY", name), {
      cause: error,
    });
  }
  if (raw.byteLength !== KEY_BYTES) {
    throw new CryptoError(INVALID_KEY.replace("SECRETS_KEY", name));
  }
  return await crypto.subtle.importKey("raw", raw, ALGORITHM, false, [
    "decrypt",
    "encrypt",
  ]);
};

/**
 * The AES-GCM key from a key spec: `SECRETS_KEY` (standard base64 of 32
 * bytes), or `SECRETS_KEY,SECRETS_KEY_PREVIOUS`. Non-extractable: it can
 * encrypt and decrypt, never be exported. A previous key makes
 * `decryptSecret` try it when the current key fails.
 */
export const importSecretsKey = async (spec: string): Promise<CryptoKey> => {
  const { current, previous } = splitKeySpec(spec);
  const key = await importAesKey(current, "SECRETS_KEY");
  if (previous !== undefined) {
    previousKeys.set(key, await importAesKey(previous, "SECRETS_KEY_PREVIOUS"));
  }
  return key;
};

/** `plaintext` encrypted for `binding`, as `v1:<iv>:<ciphertext>`. */
export const encryptSecret = async (
  key: CryptoKey,
  binding: SecretBinding,
  plaintext: string
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData: additionalData(binding), iv, name: ALGORITHM },
    key,
    encoder.encode(plaintext)
  );
  return `${VERSION}:${toBase64Url(iv)}:${toBase64Url(new Uint8Array(ciphertext))}`;
};

/**
 * The plaintext of `stored`, which `encryptSecret` produced for the same
 * `binding` under the same key, or under the previous key when the key was
 * imported with one. Throws a CryptoError for anything else:
 * another key, another binding, a changed byte, a bad format.
 */
export const decryptSecret = async (
  key: CryptoKey,
  binding: SecretBinding,
  stored: string
): Promise<string> => {
  const parts = stored.split(":");
  const [version, ivText, dataText] = parts;
  if (parts.length !== 3 || version !== VERSION || !ivText || !dataText) {
    throw unreadable(binding);
  }
  const iv = fromBase64Url(ivText);
  const data = fromBase64Url(dataText);
  if (!(iv && data) || iv.byteLength !== IV_BYTES) {
    throw unreadable(binding);
  }
  const params = {
    additionalData: additionalData(binding),
    iv,
    name: ALGORITHM,
  };
  try {
    return decoder.decode(await crypto.subtle.decrypt(params, key, data));
  } catch (error: unknown) {
    const previous = previousKeys.get(key);
    if (previous) {
      try {
        return decoder.decode(
          await crypto.subtle.decrypt(params, previous, data)
        );
      } catch {
        // Neither key opens it: report the current key's failure.
      }
    }
    // WebCrypto's OperationError says nothing about the key or the data.
    throw unreadable(binding, error);
  }
};

/** SHA-256 of the UTF-8 text, lowercase hex. */
export const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** The name `hashToken` had before `sha256Hex`. Same function. */
export const hashToken = sha256Hex;

const HMAC = { hash: "SHA-256", name: "HMAC" } as const;

/** An HMAC-SHA-256 key made from the UTF-8 bytes of `text`. */
export const hmacKeyFromText = (text: string): Promise<CryptoKey> =>
  crypto.subtle.importKey("raw", encoder.encode(text), HMAC, false, [
    "sign",
    "verify",
  ]);

/**
 * A signed token: the issue prefix of `kind`, the claims as base64url JSON, a
 * dot, then the base64url HMAC-SHA-256 of the payload. With `signPrefix` the
 * MAC covers the prefix and the payload, otherwise the payload alone. Both
 * forms are in use, so a token minted before this helper keeps verifying.
 */
export const signClaims = async (
  key: CryptoKey,
  kind: TokenPrefix,
  claims: unknown,
  options: { signPrefix?: boolean } = {}
): Promise<string> => {
  const prefix = kind.issue;
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signed = options.signPrefix ? `${prefix}${payload}` : payload;
  const mac = await crypto.subtle.sign(HMAC.name, key, encoder.encode(signed));
  return `${prefix}${payload}.${toBase64Url(new Uint8Array(mac))}`;
};

/**
 * The parsed JSON claims of a token that `signClaims` made, else null. The
 * token may carry any prefix of `kind`, and the caller validates the claims.
 * The MAC is checked first, against each of `keys` in turn (a current key,
 * then a previous one), and the payload is parsed only when one matches.
 * Never throws.
 */
export const openClaims = async (
  keys: readonly CryptoKey[],
  kind: TokenPrefix,
  token: string,
  options: { signPrefix?: boolean } = {}
): Promise<unknown> => {
  const prefix = kind.prefixOf(token);
  if (prefix === null) {
    return null;
  }
  const parts = token.slice(prefix.length).split(".");
  const [payloadText, signatureText] = parts;
  if (parts.length !== 2 || !payloadText || !signatureText) {
    return null;
  }
  const signature = fromBase64Url(signatureText);
  const payload = fromBase64Url(payloadText);
  if (!(signature && payload)) {
    return null;
  }
  const signed = encoder.encode(
    options.signPrefix ? `${prefix}${payloadText}` : payloadText
  );
  // subtle.verify compares in constant time.
  const checks = await Promise.all(
    keys.map((key) => crypto.subtle.verify(HMAC.name, key, signature, signed))
  );
  const genuine = checks.some(Boolean);
  if (!genuine) {
    return null;
  }
  try {
    return JSON.parse(decoder.decode(payload));
  } catch {
    return null;
  }
};

/**
 * A new token: `prefix` plus 32 random bytes, base64url. The table stores
 * `hash`, never `token`, and looks rows up by it.
 */
export const hashedToken = async (
  prefix: string
): Promise<{ token: string; hash: string }> => {
  const token = `${prefix}${toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)))}`;
  const hash = await hashToken(token);
  return { hash, token };
};

/** True when `token` hashes to `hash`, compared in constant time. */
export const tokenMatchesHash = async (
  token: string,
  hash: string
): Promise<boolean> =>
  constantTimeEqual(
    encoder.encode(await hashToken(token)),
    encoder.encode(hash)
  );
