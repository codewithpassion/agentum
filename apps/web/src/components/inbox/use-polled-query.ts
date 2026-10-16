import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "#/components/triggers/format";

export const POLL_INTERVAL_MS = 2000;

/**
 * Runs `load` now and then every POLL_INTERVAL_MS while mounted. `refresh`
 * runs it on demand. Results that arrive after unmount are dropped.
 */
export function usePolledQuery<T>(load: () => Promise<T>, initial: T | null) {
  const [data, setData] = useState<T | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  const mountedRef = useRef<boolean>(false);

  useEffect(() => {
    loadRef.current = load;
  });

  const refresh = useCallback(async () => {
    const isMounted = (): boolean => mountedRef.current;
    try {
      const next = await loadRef.current();
      if (isMounted()) {
        setData(next);
        setError(null);
      }
    } catch (caught) {
      if (isMounted()) {
        setError(errorMessage(caught));
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    const timer = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [refresh]);

  return { data, error, refresh };
}
