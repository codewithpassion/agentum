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
