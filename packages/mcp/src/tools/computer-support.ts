/**
 * Command output is unbounded; everything that consumes it is not. A model's
 * context, a D1 row and a UI list all want the head of the output plus an
 * honest note about what was dropped.
 */

/** What a single stream contributes to an activity row's detail JSON. */
export const ACTIVITY_STREAM_MAX_BYTES = 4096;

/** What one exec hands back to the calling agent. */
export const TOOL_OUTPUT_MAX_BYTES = 16_000;

export interface TruncatedText {
  /** Total size of the original, so the note can say what was dropped. */
  originalBytes: number;
  text: string;
  truncated: boolean;
}

const encoder = new TextEncoder();
// Non-fatal by default: a cut through a multi-byte sequence decodes to U+FFFD
// rather than throwing, and the loop below drops that partial character.
const decoder = new TextDecoder();

export const truncateText = (text: string, maxBytes: number): TruncatedText => {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return { originalBytes: bytes.length, text, truncated: false };
  }

  let head = decoder.decode(bytes.subarray(0, maxBytes));
  if (head.endsWith("�") && !text.includes("�")) {
    head = head.slice(0, -1);
  }
  return { originalBytes: bytes.length, text: head, truncated: true };
};

/** Appends the note a model needs to know it is not looking at everything. */
export const withTruncationNote = (result: TruncatedText): string => {
  if (!result.truncated) {
    return result.text;
  }
  const shown = encoder.encode(result.text).length;
  return `${result.text}\n[truncated: showing the first ${shown} of ${result.originalBytes} bytes]`;
};

/**
 * Path rules for the agent computer. The adapter resolves the logical filesystem paths; `..` and
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
