/** What the owner is told after starting a new session for an agent. */
export const sessionResetMessage = (retired: boolean): string =>
  retired
    ? "New session starts with the next message."
    : "No session was running.";
