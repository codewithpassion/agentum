/**
 * Takes a granted secret out of what comes back from the host it was sent to.
 * A server can echo a request header into its answer, and the answer goes to
 * the agent's transcript. The relay and the outbound entrypoint both scrub
 * with this.
 */
import { createMasker } from "@repo/protocol/masker";
import type { ProxyMatch } from "../secrets.ts";

const TEXT_TYPE =
  /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded|[\w.+-]+\+(?:json|xml)))/i;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const maskerOf = (matches: readonly ProxyMatch[]) =>
  createMasker(
    Object.fromEntries(matches.map((match) => [match.name, match.value]))
  );

/** `text` with each secret value replaced by `[secret:NAME]`. */
export const scrubText = (
  text: string,
  matches: readonly ProxyMatch[]
): string => (matches.length === 0 ? text : maskerOf(matches).mask(text));

/**
 * The body with each secret value replaced by `[secret:NAME]`. Only a text
 * body is read and rewritten; any other type passes through as it came, so a
 * binary answer is not corrupted by a text round trip.
 */
export const scrubBody = (
  bytes: Uint8Array<ArrayBuffer>,
  contentType: string | null,
  matches: readonly ProxyMatch[]
): Uint8Array<ArrayBuffer> => {
  if (matches.length === 0) {
    return bytes;
  }
  if (contentType !== null && !TEXT_TYPE.test(contentType)) {
    return bytes;
  }
  const text = decoder.decode(bytes);
  const masked = maskerOf(matches).mask(text);
  return masked === text ? bytes : encoder.encode(masked);
};
