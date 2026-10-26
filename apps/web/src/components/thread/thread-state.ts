// The state of the task thread (V2.12): the messages folded from the stored
// events, plus the event frames applied since the last fetch. A fresh
// `tasks.get` rebuilds the messages, then replays the tail, so a frame that
// arrived before the fetch is neither lost nor counted twice. Pure: the thread
// component owns the EventSource.

import type { EventFrame, StreamFrame } from "@repo/protocol/stream";
import {
  applyFrame,
  foldThread,
  type ThreadEvent,
  type ThreadMessage,
} from "@repo/protocol/thread";

export interface ThreadState {
  messages: ThreadMessage[];
  /** Event frames applied since the last fetch. Only events are kept: deltas and status frames are not replayed. */
  tail: EventFrame[];
}

export const initialThread = (events: readonly ThreadEvent[]): ThreadState => ({
  messages: foldThread(events),
  tail: [],
});

export const applyThreadFrame = (
  state: ThreadState,
  frame: StreamFrame
): ThreadState => {
  const messages = applyFrame(state.messages, frame);
  if (messages === state.messages) {
    return state;
  }
  return {
    messages,
    tail: frame.frame === "event" ? [...state.tail, frame] : state.tail,
  };
};

/** Rebuild from a fresh fetch of the events, then replay the tail the fetch may not have covered. */
export const resetThread = (
  state: ThreadState,
  events: readonly ThreadEvent[]
): ThreadState => {
  let next = initialThread(events);
  for (const frame of state.tail) {
    next = applyThreadFrame(next, frame);
  }
  const last = events.at(-1)?.id;
  return {
    messages: next.messages,
    tail:
      last === undefined
        ? state.tail
        : state.tail.filter((item) => item.id > last),
  };
};
