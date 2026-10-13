import { useCallback, useEffect, useRef, useState } from "react";

import {
  type ComputerDesktopServer,
  type DesktopFrameProblem,
  type DesktopStatus,
  readDesktopFailure,
  toFrameProblem,
} from "#/lib/desktop-api";
import { type DesktopAction, packActions } from "#/lib/desktop-input";

export const FRAME_INTERVAL_MS = 500;
export const HIDDEN_FRAME_INTERVAL_MS = 2000;
export const STATUS_INTERVAL_MS = 3000;
const HIDDEN_STATUS_INTERVAL_MS = 10_000;
/** While someone else holds control there is no frame to fetch, so status is watched closer instead. */
export const OTHER_CONTROL_STATUS_INTERVAL_MS = 2000;
export const INPUT_BATCH_MS = 100;
/** Refresh the lease expiry after input once it is this close, so the warning clears promptly. */
const EXPIRY_REFRESH_WINDOW_MS = 90_000;

function isHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  );
}

function otherHumanControls(status: DesktopStatus | null): boolean {
  return (
    status !== null &&
    status.controller.kind === "human" &&
    !status.controller.isMe
  );
}

export interface DesktopScreenTarget {
  /** The saved agent whose desktop this is. */
  agentId: string;
  computerId: string;
  /** Stops frame and status requests while the view cannot be seen; control is kept, not handed back. */
  paused?: boolean;
  server: ComputerDesktopServer;
}

export interface DesktopFrame {
  receivedAt: number;
  url: string;
}

function sameProblem({
  a,
  b,
}: {
  a: DesktopFrameProblem | null;
  b: DesktopFrameProblem | null;
}): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  if (a.kind !== b.kind) {
    return false;
  }
  return !("message" in a && "message" in b) || a.message === b.message;
}

/**
 * Polls one desktop's frames and status and sends input while the caller holds control.
 * Frames live only as the one object URL on screen; each replaces and revokes the last.
 * Input goes out one request at a time; whatever queues meanwhile goes in the next one.
 */
export function useDesktopScreen({
  server,
  computerId,
  agentId,
  paused = false,
}: DesktopScreenTarget) {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [frame, setFrame] = useState<DesktopFrame | null>(null);
  const [frameProblem, setFrameProblem] = useState<DesktopFrameProblem | null>(
    null
  );
  const [inputError, setInputError] = useState<string | null>(null);

  const scopeRef = useRef({ agentId, computerId, server });
  scopeRef.current = { agentId, computerId, server };

  const frameUrlRef = useRef<string | null>(null);
  // Frames are applied newest-request-first, so a slow poll never paints over an input's frame.
  const frameSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const statusRef = useRef<DesktopStatus | null>(null);
  const frameProblemRef = useRef<DesktopFrameProblem | null>(null);
  const pollFrameSoonRef = useRef<(delayMs: number) => void>(() => undefined);
  const refreshStatusRef = useRef<() => Promise<void>>(() => Promise.resolve());

  const queueRef = useRef<DesktopAction[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputInFlightRef = useRef<boolean>(false);
  const flushWaitersRef = useRef<(() => void)[]>([]);
  const activeRef = useRef<boolean>(true);
  // Bumped when this view leaves a desktop, so input still in flight stops at the next batch.
  const generationRef = useRef(0);

  // Bumped by every status an action returns, so a poll that started earlier cannot undo it.
  const statusVersionRef = useRef(0);
  const setKnownStatus = useCallback((next: DesktopStatus) => {
    const wasLocked = otherHumanControls(statusRef.current);
    statusRef.current = next;
    // Frames were paused while someone else had control; fetch one as soon as they let go.
    if (wasLocked && !otherHumanControls(next)) {
      pollFrameSoonRef.current(0);
    }
    setStatus(next);
    setStatusError(null);
  }, []);
  const applyStatus = useCallback(
    (next: DesktopStatus) => {
      statusVersionRef.current += 1;
      setKnownStatus(next);
    },
    [setKnownStatus]
  );

  const showFrame = useCallback((blob: Blob, seq: number) => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: activeRef is written by the effects, which the checker cannot see
    if (!activeRef.current || seq < appliedSeqRef.current) {
      return;
    }
    appliedSeqRef.current = seq;
    const url = URL.createObjectURL(blob);
    const previous = frameUrlRef.current;
    frameUrlRef.current = url;
    if (previous !== null) {
      URL.revokeObjectURL(previous);
    }
    setFrame({ receivedAt: Date.now(), url });
    frameProblemRef.current = null;
    setFrameProblem(null);
  }, []);

  // A down machine is re-reported every tick; the same problem must not re-render the view.
  const reportProblem = useCallback((next: DesktopFrameProblem) => {
    if (sameProblem({ a: frameProblemRef.current, b: next })) {
      return;
    }
    frameProblemRef.current = next;
    setFrameProblem(next);
  }, []);

  const dropFrame = useCallback(() => {
    const previous = frameUrlRef.current;
    frameUrlRef.current = null;
    if (previous !== null) {
      URL.revokeObjectURL(previous);
    }
    setFrame(null);
  }, []);

  // Status: one request at a time, slower while the tab is hidden.
  // biome-ignore lint/correctness/useExhaustiveDependencies: computerId and agentId restart this effect for another desktop; the body reads them through scopeRef
  useEffect(() => {
    if (paused) {
      return;
    }
    activeRef.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;

    const load = (): Promise<void> => {
      if (inFlight !== null) {
        return inFlight;
      }
      const { server: port, ...req } = scopeRef.current;
      const version = statusVersionRef.current;
      inFlight = port
        .getDesktopStatus(req)
        .then((next) => {
          if (!stopped && version === statusVersionRef.current) {
            setKnownStatus(next);
          }
        })
        .catch((error: unknown) => {
          if (stopped) {
            return;
          }
          const failure = readDesktopFailure(error);
          setStatusError(
            failure?.message ||
              (error instanceof Error
                ? error.message
                : "Could not read the desktop")
          );
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    };
    const tick = () => {
      timer = null;
      load().finally(() => {
        if (stopped) {
          return;
        }
        let delayMs = STATUS_INTERVAL_MS;
        if (isHidden()) {
          delayMs = HIDDEN_STATUS_INTERVAL_MS;
        } else if (otherHumanControls(statusRef.current)) {
          delayMs = OTHER_CONTROL_STATUS_INTERVAL_MS;
        }
        timer = setTimeout(tick, delayMs);
      });
    };
    refreshStatusRef.current = load;
    tick();
    return () => {
      stopped = true;
      activeRef.current = false;
      if (timer !== null) {
        clearTimeout(timer);
      }
    };
  }, [computerId, agentId, paused, setKnownStatus]);

  // Frames: one request at a time, every 500 ms while visible and every 2 s while hidden.
  // biome-ignore lint/correctness/useExhaustiveDependencies: computerId and agentId restart this effect for another desktop; the body reads them through scopeRef
  useEffect(() => {
    if (paused) {
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let controller: AbortController | null = null;

    const interval = () =>
      isHidden() || frameProblemRef.current?.kind === "human_in_control"
        ? HIDDEN_FRAME_INTERVAL_MS
        : FRAME_INTERVAL_MS;
    const schedule = (delayMs: number) => {
      if (stopped || inFlight) {
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(tick, delayMs);
    };
    const tick = () => {
      timer = null;
      const known = statusRef.current;
      // A machine known to be down has no frame to give; status polling notices when it is back.
      if (known !== null && !(known.online && known.desktop)) {
        reportProblem(
          known.online
            ? { kind: "unavailable", message: "" }
            : { kind: "offline" }
        );
        schedule(interval());
        return;
      }
      // Another person's screen is theirs alone: no requests (each would be refused) until status says they let go.
      if (otherHumanControls(known)) {
        reportProblem({ kind: "human_in_control" });
        dropFrame();
        schedule(interval());
        return;
      }
      inFlight = true;
      controller = new AbortController();
      frameSeqRef.current += 1;
      const seq = frameSeqRef.current;
      const { server: port, ...req } = scopeRef.current;
      port
        .getDesktopScreenshot({ ...req, signal: controller.signal })
        .then((blob) => {
          if (!stopped) {
            showFrame(blob, seq);
          }
        })
        .catch((error: unknown) => {
          if (stopped) {
            return;
          }
          const problem = toFrameProblem(error);
          reportProblem(problem);
          // Another person's screen is theirs alone, so nothing of it stays on this one; status
          // learns of them now, so polling pauses instead of waiting for the next status tick.
          if (problem.kind === "human_in_control") {
            dropFrame();
            refreshStatusRef.current();
          }
        })
        .finally(() => {
          inFlight = false;
          controller = null;
          schedule(interval());
        });
    };
    const onVisibilityChange = () => {
      if (!isHidden()) {
        schedule(0);
      }
    };
    pollFrameSoonRef.current = schedule;
    document.addEventListener("visibilitychange", onVisibilityChange);
    tick();
    return () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      pollFrameSoonRef.current = () => undefined;
    };
  }, [computerId, agentId, paused, showFrame, dropFrame, reportProblem]);

  // Released frames and queued input belong to this desktop only, and so does control of it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: computerId and agentId restart this effect for another desktop; the body reads them through scopeRef
  useEffect(() => {
    const target = scopeRef.current;
    return () => {
      generationRef.current += 1;
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
      }
      flushTimerRef.current = null;
      queueRef.current = [];
      const waiting = flushWaitersRef.current;
      flushWaitersRef.current = [];
      for (const resolve of waiting) {
        resolve();
      }
      const previous = frameUrlRef.current;
      frameUrlRef.current = null;
      if (previous !== null) {
        URL.revokeObjectURL(previous);
      }
      // Leaving while in control would lock everyone else out until the lease lapses.
      const controller = statusRef.current?.controller;
      statusRef.current = null;
      if (controller?.kind === "human" && controller.isMe) {
        const { server: port, ...req } = target;
        port.handBackDesktop(req).catch(() => undefined);
      }
    };
  }, [computerId, agentId]);

  /** Sends one pass of queued input; a refusal drops the rest of it and anything queued since. */
  const sendBatches = useCallback(
    async ({
      actions,
      generation,
    }: {
      actions: DesktopAction[];
      generation: number;
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ported as-is from TrueForge; splitting it would scatter the shared refs
    }): Promise<void> => {
      for (const batch of packActions(actions)) {
        if (generation !== generationRef.current) {
          return;
        }
        frameSeqRef.current += 1;
        const seq = frameSeqRef.current;
        const { server: port, ...req } = scopeRef.current;
        try {
          // biome-ignore lint/performance/noAwaitInLoops: one input request in flight by design
          const blob = await port.sendDesktopInput({ ...req, actions: batch });
          if (generation !== generationRef.current) {
            return;
          }
          showFrame(blob, seq);
          setInputError(null);
          pollFrameSoonRef.current(FRAME_INTERVAL_MS);
        } catch (error: unknown) {
          if (generation !== generationRef.current) {
            return;
          }
          const failure = readDesktopFailure(error);
          setInputError(
            failure?.statusCode === 423
              ? "You no longer control the desktop."
              : failure?.message ||
                  (error instanceof Error
                    ? error.message
                    : "Input was not delivered")
          );
          // Input typed after control was lost must not land once it is taken again.
          queueRef.current = [];
          refreshStatusRef.current();
          return;
        }
      }
      const controller = statusRef.current?.controller;
      if (
        controller?.kind === "human" &&
        Date.parse(controller.expiresAt) - Date.now() < EXPIRY_REFRESH_WINDOW_MS
      ) {
        refreshStatusRef.current();
      }
    },
    [showFrame]
  );

  // One input request at a time; moves queued during a slow round trip merge into the next pass.
  const drainInput = useCallback(async () => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: inputInFlightRef is written by this function after the check
    if (inputInFlightRef.current) {
      return;
    }
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
    }
    flushTimerRef.current = null;
    inputInFlightRef.current = true;
    try {
      while (
        queueRef.current.length > 0 ||
        flushWaitersRef.current.length > 0
      ) {
        const generation = generationRef.current;
        const waiters = flushWaitersRef.current;
        flushWaitersRef.current = [];
        const actions = queueRef.current;
        queueRef.current = [];
        const passStart = Date.now();
        if (actions.length > 0) {
          // biome-ignore lint/performance/noAwaitInLoops: input passes run one after another by design
          await sendBatches({ actions, generation });
        }
        for (const resolve of waiters) {
          resolve();
        }
        // A fast link still sends at most about ten requests a second, unless someone is waiting on a flush.
        const early = INPUT_BATCH_MS - (Date.now() - passStart);
        if (
          early > 0 &&
          queueRef.current.length > 0 &&
          flushWaitersRef.current.length === 0
        ) {
          await new Promise((resolve) => setTimeout(resolve, early));
        }
      }
    } finally {
      inputInFlightRef.current = false;
    }
  }, [sendBatches]);

  /**
   * Sends everything queued now; resolves once it was delivered or refused. `dropMoves` skips
   * queued pointer moves (presses, releases and keys still go) so handing back is not held up.
   */
  const flushInput = useCallback(
    ({ dropMoves = false }: { dropMoves?: boolean } = {}): Promise<void> => {
      if (dropMoves) {
        queueRef.current = queueRef.current.filter(
          (action) => action.type !== "mouse_move"
        );
      }
      const delivered = new Promise<void>((resolve) => {
        flushWaitersRef.current.push(resolve);
      });
      drainInput();
      return delivered;
    },
    [drainInput]
  );

  /** Queues input; it goes out about 100 ms later, or as soon as the request before it lands. */
  const sendInput = useCallback(
    (actions: DesktopAction[]) => {
      if (actions.length === 0) {
        return;
      }
      queueRef.current.push(...actions);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: inputInFlightRef is written by drainInput, which the checker cannot see
      if (inputInFlightRef.current || flushTimerRef.current !== null) {
        return;
      }
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        drainInput();
      }, INPUT_BATCH_MS);
    },
    [drainInput]
  );

  /** Puts local text on the remote clipboard (CLIPBOARD and PRIMARY) and pastes it with ctrl+v. */
  const pasteText = useCallback(
    async (text: string) => {
      await flushInput();
      const { server: port, ...req } = scopeRef.current;
      await port.setDesktopClipboard({ ...req, text });
      sendInput([{ keys: "ctrl+v", type: "key" }]);
      await flushInput();
    },
    [flushInput, sendInput]
  );

  const refreshStatus = useCallback(() => refreshStatusRef.current(), []);

  return {
    applyStatus,
    flushInput,
    frame,
    frameProblem,
    inputError,
    pasteText,
    refreshStatus,
    sendInput,
    status,
    statusError,
  };
}
