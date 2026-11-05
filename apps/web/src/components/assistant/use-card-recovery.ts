import { useCallback, useEffect, useState } from "react";
import type { CardOutcome } from "./types";

/** Only the outcome is retained across reloads. The typed value never enters storage. */
export function useCardRecovery(key?: string) {
  const [outcome, setOutcome] = useState<CardOutcome>();
  const storageKey = key ? `assistant-card:${key}` : null;
  useEffect(() => {
    if (!storageKey) {
      return;
    }
    try {
      const saved = window.sessionStorage.getItem(storageKey);
      if (saved) {
        setOutcome(JSON.parse(saved) as CardOutcome);
      }
    } catch {
      /* A browser may disable session storage. In-memory retries still work. */
    }
  }, [storageKey]);
  const remember = useCallback(
    (next: CardOutcome) => {
      setOutcome(next);
      if (!storageKey) {
        return;
      }
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        /* The value is already stored securely; keep the in-memory outcome. */
      }
    },
    [storageKey]
  );
  const forget = useCallback(() => {
    if (!storageKey) {
      return;
    }
    try {
      window.sessionStorage.removeItem(storageKey);
    } catch {
      /* The server's idempotent resolve makes a retained outcome harmless. */
    }
  }, [storageKey]);
  return { forget, outcome, remember };
}
