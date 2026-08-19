/**
 * Path rules for the agent computer. The filesystem lives inside a Durable
 * Object, so there is nothing outside the workspace to escape to - but `..` and
 * unnormalised paths still make the activity log lie about which file changed,
 * and an agent that can address `/a/../b` can hide a write behind a plausible
 * path. Everything therefore goes through here first.
 */

const MAX_PATH_LENGTH = 1024;

/** A single file, both directions. Big enough for source and notes, not for blobs. */
export const MAX_FILE_BYTES = 1_000_000;

/** What a read returns to an agent before it is refused outright. */
export const MAX_READ_BYTES = 256_000;

export type PathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

const REPEATED_SLASHES = /\/{2,}/g;

export const validatePath = (raw: unknown): PathResult => {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "A path is required." };
  }
  if (!raw.startsWith("/")) {
    return {
      ok: false,
      reason: `Paths must be absolute and start with "/" - got "${raw}".`,
    };
  }
  if (raw.length > MAX_PATH_LENGTH) {
    return {
      ok: false,
      reason: `Paths must be at most ${MAX_PATH_LENGTH} characters.`,
    };
  }
  if (raw.includes("\0")) {
    return { ok: false, reason: "Paths must not contain null bytes." };
  }

  const collapsed = raw.replace(REPEATED_SLASHES, "/");
  const segments = collapsed.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      return {
        ok: false,
        reason: `Paths must be already resolved: "." and ".." are not allowed (got "${raw}").`,
      };
    }
  }

  // Trailing slashes would make "/notes" and "/notes/" two different keys in
  // the activity log for one directory.
  const trimmed =
    collapsed.length > 1 && collapsed.endsWith("/")
      ? collapsed.slice(0, -1)
      : collapsed;
  return { ok: true, path: trimmed };
};

export const byteLength = (text: string): number =>
  new TextEncoder().encode(text).length;

export type ContentResult =
  | { ok: true; content: string }
  | { ok: false; reason: string };

export const validateContent = (
  raw: unknown,
  maxBytes = MAX_FILE_BYTES
): ContentResult => {
  if (typeof raw !== "string") {
    return { ok: false, reason: "File content must be a string." };
  }
  const size = byteLength(raw);
  if (size > maxBytes) {
    return {
      ok: false,
      reason: `File content is ${size} bytes, over the ${maxBytes} byte limit.`,
    };
  }
  return { content: raw, ok: true };
};
