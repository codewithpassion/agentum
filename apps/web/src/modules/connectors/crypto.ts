/**
 * Envelope encryption for the connector tokens kept in D1. One `CONNECTOR_KEY`
 * Worker secret (base64, 32 bytes) keys AES-GCM through WebCrypto; the random
 * 96-bit IV is prepended to the ciphertext, so a stored value is entirely
 * self-describing and no second column is needed to decrypt it.
 *
 * These are the *management* copies of the tokens. The vault credential is what
 * sessions use, and Anthropic never hands it back - losing the key here costs
 * "Test connection" and the tool list, not the connector.
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

export const encryptSecret = async (
  key: string,
  plaintext: string
): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { iv, name: ALGORITHM },
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
  payload: string
): Promise<string> => {
  const packed = decodeBase64(payload);
  if (packed.length <= IV_BYTES) {
    throw new Error("The stored secret is truncated.");
  }
  const plaintext = await crypto.subtle.decrypt(
    { iv: packed.subarray(0, IV_BYTES), name: ALGORITHM },
    await importKey(key),
    packed.subarray(IV_BYTES)
  );
  return new TextDecoder().decode(plaintext);
};
