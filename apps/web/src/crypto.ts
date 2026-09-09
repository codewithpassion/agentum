/**
 * Envelope encryption for the secrets kept in D1 - connector tokens, and a
 * Slack app's bot token and signing secret. One `CONNECTOR_KEY` Worker secret
 * (base64, 32 bytes) keys AES-GCM through WebCrypto; the random 96-bit IV is
 * prepended to the ciphertext, so a stored value is entirely self-describing
 * and no second column is needed to decrypt it.
 *
 * It lives at the top level rather than in a module because two modules use it
 * and neither may import the other's internals. The stored format is fixed:
 * values written before this file moved must still decrypt.
 *
 * Both functions take an optional `additionalData` that AES-GCM authenticates
 * without storing. Callers that pass one must pass the same one back to
 * decrypt; callers that pass none - every caller older than workspace secrets -
 * are byte-for-byte unchanged.
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const ALGORITHM = "AES-GCM";

const decodeBase64 = (value: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/** A fresh key, for `.env.local` and for the tests. */
export const generateConnectorKey = (): string =>
  encodeBase64(crypto.getRandomValues(new Uint8Array(KEY_BYTES)));

const importKey = async (key: string): Promise<CryptoKey> => {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = decodeBase64(key);
  } catch (error) {
    throw new Error("CONNECTOR_KEY is not valid base64.", { cause: error });
  }
  if (raw.length !== KEY_BYTES) {
    throw new Error(
      `CONNECTOR_KEY must decode to ${KEY_BYTES} bytes, got ${raw.length}.`
    );
  }
  return await crypto.subtle.importKey("raw", raw, ALGORITHM, false, [
    "encrypt",
    "decrypt",
  ]);
};

/**
 * AES-GCM's additional authenticated data: covered by the tag, but not stored
 * with the ciphertext. Passing one binds a value to where it is kept - a
 * ciphertext lifted into another row, or another tenant's row, then fails to
 * decrypt rather than yielding somebody else's secret.
 *
 * Omitting it is *not* the same as passing `""`, so the parameter is spread in
 * only when it was given: values written before AAD existed carry none, and
 * must keep decrypting with a call that passes none.
 */
const paramsFor = (
  iv: Uint8Array<ArrayBuffer>,
  additionalData: string | undefined
): AesGcmParams => ({
  iv,
  name: ALGORITHM,
  ...(additionalData === undefined
    ? {}
    : { additionalData: new TextEncoder().encode(additionalData) }),
});

export const encryptSecret = async (
  key: string,
  plaintext: string,
  additionalData?: string
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    paramsFor(iv, additionalData),
    await importKey(key),
    new TextEncoder().encode(plaintext)
  );

  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return encodeBase64(packed);
};

export const decryptSecret = async (
  key: string,
  payload: string,
  additionalData?: string
): Promise<string> => {
  const packed = decodeBase64(payload);
  if (packed.length <= IV_BYTES) {
    throw new Error("The stored secret is truncated.");
  }
  const plaintext = await crypto.subtle.decrypt(
    paramsFor(packed.subarray(0, IV_BYTES), additionalData),
    await importKey(key),
    packed.subarray(IV_BYTES)
  );
  return new TextDecoder().decode(plaintext);
};
