import { useEffect, useRef, useState } from "react";
import { startPolling } from "#/components/inbox/use-polled-query";

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

  useEffect(
    () =>
      startPolling(() => {
        onTickRef.current();
        setTick((count) => count + 1);
      }, LIBRARY_REFRESH_MS),
    []
  );

  return tick;
}
