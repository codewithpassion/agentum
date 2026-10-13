/** What the owner is told after starting a new session for an agent. */
export const sessionResetMessage = (retired: boolean): string =>
  retired
    ? "New session starts with the next message."
    : "No session was running.";

const END_REASON_LABELS: Record<string, string> = {
  error: "ended on an error",
  idle_ttl: "went quiet",
  imported: "earlier session",
  model_changed: "model changed",
  new_task: "new task",
  reset: "new session",
  switched: "switched away",
  terminated: "finished",
  tools_changed: "tools changed",
};

/** A short phrase for why a session ended; null while it is the current one. */
export const sessionEndLabel = (endReason: string | null): string | null =>
  endReason === null ? null : (END_REASON_LABELS[endReason] ?? endReason);
