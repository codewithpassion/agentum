import { useEffect } from "react";

/**
 * How the right rail keeps up with an agent. The computer and browser write to
 * D1 from outside any channel room, so there is no socket to listen on: the
 * open tab polls, fast while the agent is working and slowly once it is not.
 */

export const ACTIVE_POLL_MS = 4000;
export const IDLE_POLL_MS = 15_000;

export const pollIntervalFor = (working: boolean): number =>
  working ? ACTIVE_POLL_MS : IDLE_POLL_MS;

/**
 * Runs `load` once and then on an interval, for as long as the caller is
 * mounted - a tab that is not the open one is not rendered, so it costs
 * nothing. `load` must be a stable callback.
 */
export const usePolling = (load: () => void, intervalMs: number): void => {
  useEffect(() => {
    load();
    const timer = setInterval(load, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, load]);
};
