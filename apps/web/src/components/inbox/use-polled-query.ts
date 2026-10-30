import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "#/components/triggers/format";

export const POLL_INTERVAL_MS = 2000;
export const DESK_POLL_INTERVAL_MS = 10_000;

/**
 * Runs `load` now, then every `intervalMs` while mounted, skipping ticks
 * while the document is hidden. It also runs again when the window gets
 * focus or the document becomes visible. `refresh` runs it on demand.
 * Results that arrive after unmount, or after a newer load started, are dropped.
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
  const latestRef = useRef(0);

  useEffect(() => {
    loadRef.current = load;
  });

  const refresh = useCallback(async () => {
    // A result counts only while no newer load has started, so a slow load
    // cannot overwrite what a later one already returned.
    latestRef.current += 1;
    const sequence = latestRef.current;
    const isMounted = (): boolean => mountedRef.current;
    const isCurrent = (): boolean =>
      isMounted() && sequence === latestRef.current;
    try {
      const next = await loadRef.current();
      if (isCurrent()) {
        setData(next);
        setError(null);
      }
    } catch (caught) {
      if (isCurrent()) {
        setError(errorMessage(caught));
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const refreshIfVisible = (): void => {
      if (!document.hidden) {
        refresh();
      }
    };
    refresh();
    const timer = setInterval(refreshIfVisible, intervalMs);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [refresh, intervalMs]);

  return { data, error, refresh };
}
