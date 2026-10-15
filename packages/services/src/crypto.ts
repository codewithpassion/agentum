/**
 * Secrets at rest: AES-GCM 256 under one Worker secret, `SECRETS_KEY`
 * (32 random bytes, base64). Also the random tokens a table stores only as
 * a hash. Pure Web Crypto, so it runs in workerd and in bun alike.
 *
 * Stored form: `v1:<base64url iv>:<base64url ciphertext>`, a fresh 12-byte IV
 * per value. The additional authenticated data is the JSON array of the
 * workspace, table, row and field ids, so a ciphertext copied into another
 * row, table or field fails to decrypt instead of handing over a credential.
 * The `v1` prefix leaves room for a key rotation.
 *
 * Errors are CryptoErrors that never carry plaintext, ciphertext or key bytes.
 */

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

/**
 * The AES-GCM key from `SECRETS_KEY` (standard base64 of 32 bytes).
 * Non-extractable: it can encrypt and decrypt, never be exported.
 */
export const importSecretsKey = async (base64: string): Promise<CryptoKey> => {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(base64.trim());
    raw = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch (error: unknown) {
    throw new CryptoError(INVALID_KEY, { cause: error });
  }
  if (raw.byteLength !== KEY_BYTES) {
    throw new CryptoError(INVALID_KEY);
  }
  return await crypto.subtle.importKey("raw", raw, ALGORITHM, false, [
    "decrypt",
    "encrypt",
  ]);
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
 * `binding` under the same key. Throws a CryptoError for anything else:
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
  try {
    const plaintext = await crypto.subtle.decrypt(
      { additionalData: additionalData(binding), iv, name: ALGORITHM },
      key,
      data
    );
    return decoder.decode(plaintext);
  } catch (error: unknown) {
    // WebCrypto's OperationError says nothing about the key or the data.
    throw unreadable(binding, error);
  }
};

/** SHA-256 of the UTF-8 token, lowercase hex. */
export const hashToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
