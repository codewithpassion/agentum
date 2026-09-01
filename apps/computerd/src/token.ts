/**
 * The daemon's half of the host credential. Mirrors `hashMcpToken` and
 * `timingSafeEqual` in `apps/web/src/modules/agents/mcp-token.ts` byte for
 * byte - SHA-256, lower-case hex - because Agentum generates the token and
 * stores only the hash, and the two sides have to agree on what "the hash of
 * this token" means.
 *
 * The daemon never holds a plaintext token in listen mode: it is given
 * `COMPUTERD_TOKEN_HASH` and compares what a caller presents against it.
 */

const HEX_RADIX = 16;
const BYTE_HEX_LENGTH = 2;
const BEARER = /^Bearer\s+/i;

export const hashToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(HEX_RADIX).padStart(BYTE_HEX_LENGTH, "0"))
    .join("");
};

/**
 * Compares two hex digests without leaking where they diverge. Both operands
 * are hashes, so a length mismatch is not itself a secret.
 */
export const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (const [index, character] of [...a].entries()) {
    // Summing per-character inequality keeps the loop's cost independent of
    // where the two digests first differ. Biome forbids bitwise operators, and
    // an early return here would leak that position through timing.
    difference += character === b[index] ? 0 : 1;
  }
  return difference === 0;
};

/** Pulls the token out of `Authorization: Bearer <token>`. */
export const bearerToken = (header: string | null): string | null => {
  if (!(header && BEARER.test(header))) {
    return null;
  }
  const token = header.replace(BEARER, "").trim();
  return token.length > 0 ? token : null;
};

/** True when the presented header carries a token matching `expectedHash`. */
export const isAuthorized = async (
  header: string | null,
  expectedHash: string
): Promise<boolean> => {
  const token = bearerToken(header);
  if (!token) {
    return false;
  }
  return timingSafeEqual(await hashToken(token), expectedHash.toLowerCase());
};
