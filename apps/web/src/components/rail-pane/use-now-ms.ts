import { useEffect, useState } from "react";

const CLOCK_TICK_MS = 30_000;

/** The current time, set after mount so server and browser markup match. */
export function useNowMs(): number | null {
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const timer = setInterval(() => setNowMs(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}
