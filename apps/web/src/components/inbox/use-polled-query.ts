import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "#/lib/error-message";

export const POLL_INTERVAL_MS = 2000;
export const DESK_POLL_INTERVAL_MS = 10_000;

/**
 * Calls `run` every `intervalMs`, skipping ticks while the document is hidden.
 * It also calls `run` when the window gets focus or the document becomes
 * visible. It does not call `run` on start. Returns the function that stops it.
 * Every poll in the app goes through here, so a hidden tab stays quiet.
 */
export function startPolling(run: () => void, intervalMs: number): () => void {
  const runIfVisible = (): void => {
    if (!document.hidden) {
      run();
    }
  };
  const timer = setInterval(runIfVisible, intervalMs);
  window.addEventListener("focus", runIfVisible);
  document.addEventListener("visibilitychange", runIfVisible);
  return () => {
    clearInterval(timer);
    window.removeEventListener("focus", runIfVisible);
    document.removeEventListener("visibilitychange", runIfVisible);
  };
}

/**
 * Runs `load` now, then every `intervalMs` while mounted, skipping ticks
 * while the document is hidden. It also runs again when the window gets
 * focus or the document becomes visible. `refresh` runs it on demand.
 * Results that arrive after unmount, or after a newer load landed, are dropped.
 */
export function usePolledQuery<T>(
  load: () => Promise<T>,
  initial: T | null,
  intervalMs = POLL_INTERVAL_MS
) {
  const [data, setData] = useState<T | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  const mountedRef = useRef<boolean>(false);
  const startedRef = useRef(0);
  const landedRef = useRef(0);

  useEffect(() => {
    loadRef.current = load;
  });

  const refresh = useCallback(async () => {
    // A result counts unless a newer load has already landed, so a slow load
    // cannot overwrite what a later one returned. A load slower than the poll
    // interval still lands, as nothing newer has.
    startedRef.current += 1;
    const sequence = startedRef.current;
    const isMounted = (): boolean => mountedRef.current;
    const lands = (): boolean => {
      if (!isMounted() || sequence < landedRef.current) {
        return false;
      }
      landedRef.current = sequence;
      return true;
    };
    try {
      const next = await loadRef.current();
      if (lands()) {
        setData(next);
        setError(null);
      }
    } catch (caught) {
      if (lands()) {
        setError(errorMessage(caught));
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const stop = startPolling(refresh, intervalMs);
    return () => {
      mountedRef.current = false;
      stop();
    };
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}
