import { type DesktopAction, packActions } from "#/lib/desktop-input";

/** Pointer moves with no button down go out at most this often. */
export const IDLE_MOVE_INTERVAL_MS = 50;

export interface InputCoalescerOptions {
  now?: () => number;
  /** Runs `run` on the next animation frame and returns a way to cancel it. */
  schedule?: (run: () => void) => () => void;
  /** Sends one batch; false means it could not go. */
  send: (batch: DesktopAction[]) => boolean;
}

const nextFrame = (run: () => void): (() => void) => {
  if (typeof requestAnimationFrame === "function") {
    const handle = requestAnimationFrame(run);
    return () => cancelAnimationFrame(handle);
  }
  const handle = setTimeout(run, 16);
  return () => clearTimeout(handle);
};

/**
 * Batches input for the socket: everything queued in one animation frame goes out
 * together, and only the newest pointer move is kept. While a button is down every
 * frame's move is sent (a drag must follow the pointer); otherwise moves are
 * spaced IDLE_MOVE_INTERVAL_MS apart. Order against presses, scrolls and keys is
 * kept: a held move is sent before whatever follows it.
 */
export function createInputCoalescer({
  now = Date.now,
  schedule = nextFrame,
  send,
}: InputCoalescerOptions) {
  let queue: DesktopAction[] = [];
  let heldMove: DesktopAction | null = null;
  let buttonsDown = 0;
  let lastMoveAt = Number.NEGATIVE_INFINITY;
  let cancel: (() => void) | null = null;

  const release = (force: boolean): DesktopAction[] => {
    const out = queue;
    queue = [];
    const due = now() - lastMoveAt >= IDLE_MOVE_INTERVAL_MS;
    if (heldMove && (force || buttonsDown > 0 || due)) {
      out.push(heldMove);
      heldMove = null;
      lastMoveAt = now();
    }
    return out;
  };

  const deliver = (actions: DesktopAction[]) => {
    for (const batch of packActions(actions)) {
      send(batch);
    }
  };

  const run = () => {
    cancel = null;
    deliver(release(false));
    if (heldMove) {
      cancel = schedule(run);
    }
  };

  const ensureScheduled = () => {
    if (cancel === null) {
      cancel = schedule(run);
    }
  };

  const reset = () => {
    cancel?.();
    cancel = null;
    queue = [];
    heldMove = null;
    buttonsDown = 0;
  };

  return {
    /** Sends everything now. `dropMoves` leaves out pointer moves, as handing back does. */
    flush: ({ dropMoves = false }: { dropMoves?: boolean } = {}) => {
      cancel?.();
      cancel = null;
      if (dropMoves) {
        heldMove = null;
        queue = queue.filter((action) => action.type !== "mouse_move");
      }
      deliver(release(true));
    },
    push: (actions: readonly DesktopAction[]) => {
      for (const action of actions) {
        if (action.type === "mouse_move") {
          heldMove = action;
          continue;
        }
        if (heldMove) {
          queue.push(heldMove);
          heldMove = null;
          lastMoveAt = now();
        }
        if (action.type === "mouse_down") {
          buttonsDown += 1;
        } else if (action.type === "mouse_up") {
          buttonsDown = Math.max(0, buttonsDown - 1);
        }
        queue.push(action);
      }
      ensureScheduled();
    },
    reset,
  };
}
