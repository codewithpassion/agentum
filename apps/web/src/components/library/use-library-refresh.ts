import { useEffect, useRef, useState } from "react";

/** How often the library refetches while its tab is visible. */
export const LIBRARY_REFRESH_MS = 5000;

/**
 * Calls `onTick` every 5 s while the tab is visible, and again when the window
 * gets focus or the tab becomes visible. Library events carry no session, so no
 * browser stream gets them and polling is the refresh. Returns a counter that
 * goes up on every tick, for children that refetch their own data.
 */
export function useLibraryRefresh(onTick: () => void): number {
  const [tick, setTick] = useState(0);
  const onTickRef = useRef(onTick);

  useEffect(() => {
    onTickRef.current = onTick;
  });

  useEffect(() => {
    const run = (): void => {
      if (document.hidden) {
        return;
      }
      onTickRef.current();
      setTick((count) => count + 1);
    };
    const timer = setInterval(run, LIBRARY_REFRESH_MS);
    window.addEventListener("focus", run);
    document.addEventListener("visibilitychange", run);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", run);
      document.removeEventListener("visibilitychange", run);
    };
  }, []);

  return tick;
}
