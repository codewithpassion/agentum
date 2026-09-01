/**
 * Command output is unbounded; the socket carrying it back is not. Mirrors
 * `apps/web/src/modules/computer/output.ts` - same cap, same note - so a
 * truncated stream reads the same however far down the stack it was cut.
 */

/** What one exec hands back to the calling agent, per stream. */
export const TOOL_OUTPUT_MAX_BYTES = 16_000;

export interface TruncatedText {
  /** Total size of the original, so the note can say what was dropped. */
  originalBytes: number;
  text: string;
  truncated: boolean;
}

const encoder = new TextEncoder();
// Non-fatal by default: a cut through a multi-byte sequence decodes to U+FFFD
// rather than throwing, and `truncateBytes` drops that partial character.
const decoder = new TextDecoder();

/**
 * `head` is the retained prefix and `originalBytes` the size of everything that
 * went past - the daemon counts every byte a command produces but only keeps
 * the head, so a runaway `yes` cannot fill this process's memory either.
 */
export const truncateBytes = (
  head: Uint8Array,
  originalBytes: number,
  maxBytes: number
): TruncatedText => {
  const text = decoder.decode(head);
  if (originalBytes <= maxBytes) {
    return { originalBytes, text, truncated: false };
  }
  // A replacement character at the very end came from the cut, near enough
  // always: the alternative is a genuine U+FFFD that happens to end exactly
  // there, and dropping one of those costs nothing.
  return {
    originalBytes,
    text: text.endsWith("�") ? text.slice(0, -1) : text,
    truncated: true,
  };
};

/** Appends the note a model needs to know it is not looking at everything. */
export const withTruncationNote = (result: TruncatedText): string => {
  if (!result.truncated) {
    return result.text;
  }
  const shown = encoder.encode(result.text).length;
  return `${result.text}\n[truncated: showing the first ${shown} of ${result.originalBytes} bytes]`;
};
