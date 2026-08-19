/**
 * Per-agent MCP tokens. The token is the only credential on `/mcp/:agentToken`,
 * so it is 256 bits of CSPRNG output and only ever stored as a SHA-256 hash -
 * the plaintext exists once, in the create/rotate response.
 */

const TOKEN_BYTES = 32;
const BASE64_PAD = /[=]+$/;
const TRAILING_SLASHES = /\/+$/;
const HEX_RADIX = 16;
const BYTE_HEX_LENGTH = 2;

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(BASE64_PAD, "")
    .replaceAll("+", "-")
    .replaceAll("/", "_");
};

export const generateMcpToken = (): string => {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
};

export const hashMcpToken = async (token: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(HEX_RADIX).padStart(BYTE_HEX_LENGTH, "0"))
    .join("");
};

/**
 * The URL an agent's MCP client connects to. `PUBLIC_APP_URL` is authoritative;
 * the request origin is the fallback so a dev or preview host still works.
 */
export const mcpUrlForToken = (
  publicAppUrl: string | undefined,
  requestUrl: string,
  token: string
): string => {
  const base = publicAppUrl || new URL(requestUrl).origin;
  return `${base.replace(TRAILING_SLASHES, "")}/mcp/${token}`;
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
