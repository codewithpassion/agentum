/**
 * Pairing codes for agent-to-agent connections. Pure Web Crypto, so it runs
 * in workerd and in bun alike, and it never touches the database.
 *
 * The alphabet has 32 characters, so one byte masked with `& 31` picks a
 * character with no modulo bias.
 */

/** No 0, O, 1 or I, so a code reads the same when someone types it. */
export const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;

const encoder = new TextEncoder();

const toCode = (bytes: Uint8Array): string => {
  let code = "";
  for (const byte of bytes) {
    // biome-ignore lint/suspicious/noBitwiseOperators: masking to 5 bits is what makes the 32-character alphabet bias-free
    code += PAIRING_ALPHABET[byte & 31];
  }
  return code;
};

/**
 * The code both sides of a pairing show. Both sides must pass the same two
 * tokens in the same order, so both get the same code. Swapping the order
 * gives a different code.
 */
export const checkCode = async (
  inviteToken: string,
  joinerToken: string
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`${inviteToken}\n${joinerToken}`)
  );
  return toCode(new Uint8Array(digest, 0, PAIRING_CODE_LENGTH));
};

/** A fresh random code for a pairing invite. */
export const randomPairingCode = (): string =>
  toCode(crypto.getRandomValues(new Uint8Array(PAIRING_CODE_LENGTH)));

const HMAC = { hash: "SHA-256", name: "HMAC" } as const;
/** Keeps this HMAC apart from any other use of the secrets key. */
const PAIRING_CONTEXT = "harbourmaster a2a pairing code";

/**
 * The code a pairing request shows its peer: an HMAC of the request id and the
 * peer's token under the secrets key (standard base64 of 32 bytes). The same
 * token on the same request always gets the same code, so the code never has
 * to be stored, and nobody without the secrets key can work it out from the
 * stored hashes.
 */
export const pairingRequestCode = async (
  secretsKey: string,
  requestId: string,
  token: string
): Promise<string> => {
  const raw = Uint8Array.from(atob(secretsKey.trim()), (char) =>
    char.charCodeAt(0)
  );
  const key = await crypto.subtle.importKey("raw", raw, HMAC, false, ["sign"]);
  const signature = await crypto.subtle.sign(
    HMAC.name,
    key,
    encoder.encode(`${PAIRING_CONTEXT}\n${requestId}\n${token}`)
  );
  return toCode(new Uint8Array(signature, 0, PAIRING_CODE_LENGTH));
};
