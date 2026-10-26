// Streams the partial text of a running Pi generation as `delta` frames. A frame
// goes out at most once per DELTA_GAP_MS, carries the whole text so far with the
// unfinished last word held back, and is masked and redacted before it leaves.
// Tool calls and thinking blocks never reach a frame.
import type { Masker } from "@repo/protocol/masker";
import type { DeltaFrame } from "@repo/protocol/stream";
import { redactText } from "@repo/services/events/scrub";

/** The least time, in ms, between two delta frames. */
export const DELTA_GAP_MS = 250;

const TRAILING_WORD = /\S+$/;

interface LiveBlock {
  text?: string;
  type: string;
}

/** The slice of Pi's `docs["pi.live"]` that the deltas read. */
export interface LiveDoc {
  generation?: {
    message?: {
      content?: readonly LiveBlock[];
      timestamp?: number;
    };
  };
}

export interface DeltaPublisherDeps {
  clock: () => number;
  maskerOf: () => Promise<Masker | null>;
  publish: (frame: DeltaFrame) => Promise<void>;
  runId: string;
}

const textOf = (content: readonly LiveBlock[] = []): string =>
  content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");

/** Builds the publisher for one run. `offer` is called on each change to the live doc. */
export const deltaPublisher = (deps: DeltaPublisherDeps) => {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastKey: string | undefined;
  let lastText: string | undefined;

  const offer = async (live: LiveDoc | undefined): Promise<void> => {
    const message = live?.generation?.message;
    if (message === undefined) {
      return;
    }
    const joined = textOf(message.content);
    if (joined === "") {
      return;
    }
    const now = deps.clock();
    if (now - lastSentAt < DELTA_GAP_MS) {
      return;
    }
    // The unfinished last word may be a secret still being typed, so it stays back.
    const text = joined.replace(TRAILING_WORD, "");
    if (text === "") {
      return;
    }
    const messageKey = `${deps.runId}:${message.timestamp ?? 0}`;
    if (messageKey === lastKey && text === lastText) {
      return;
    }
    // Set before the first await, so an overlapping offer sees the throttle.
    lastSentAt = now;
    try {
      const masker = await deps.maskerOf();
      const masked = redactText(masker === null ? text : masker.mask(text));
      lastKey = messageKey;
      lastText = text;
      await deps.publish({
        frame: "delta",
        messageKey,
        runId: deps.runId,
        text: masked,
      });
    } catch {
      // Dropped quietly: a delta is a preview, and its text is never logged.
    }
  };

  return { offer };
};
