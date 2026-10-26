// Streams the partial text of a running Pi generation as `delta` frames. A frame
// goes out at most once per DELTA_GAP_MS, carries the whole text so far with the
// unfinished end held back, and is masked and redacted before it leaves.
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
export interface LivePartial {
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

/**
 * The text as it may leave. The cut is chosen on the raw text: the last word,
 * which may be a token still being typed, and anything that begins a granted
 * value, which may contain spaces or lines the word rule would not catch. A cut
 * that would split a whole granted value moves back to before it, found by
 * masking: a clean cut masks to the start of what the whole text masks to. The
 * pattern scrub runs last.
 */
const settled = (joined: string, masker: Masker | null): string => {
  const word = TRAILING_WORD.exec(joined)?.[0].length ?? 0;
  if (masker === null) {
    return redactText(joined.slice(0, joined.length - word));
  }
  const whole = masker.mask(joined);
  let end = joined.length - Math.max(word, masker.unfinishedTail(joined));
  while (end > 0 && !whole.startsWith(masker.mask(joined.slice(0, end)))) {
    end -= 1;
  }
  return redactText(masker.mask(joined.slice(0, end)));
};

/** Builds the publisher for one run. `offer` is called on each change to the live doc. */
export const deltaPublisher = (deps: DeltaPublisherDeps) => {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let lastKey: string | undefined;
  let lastText: string | undefined;

  const offer = async (live: LivePartial | undefined): Promise<void> => {
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
    const messageKey = `${deps.runId}:${message.timestamp ?? 0}`;
    // Set before the first await, so an overlapping offer sees the throttle.
    const before = lastSentAt;
    lastSentAt = now;
    try {
      const text = settled(joined, await deps.maskerOf());
      if (text === "" || (messageKey === lastKey && text === lastText)) {
        // Nothing new left the object, so the window stays open.
        lastSentAt = before;
        return;
      }
      await deps.publish({
        frame: "delta",
        messageKey,
        runId: deps.runId,
        text,
      });
      lastKey = messageKey;
      lastText = text;
    } catch {
      // Dropped quietly: a delta is a preview, and its text is never logged.
    }
  };

  return { offer };
};
