// "+ Agent" dropped on the canvas opens the agent builder, and the agent only
// exists once the builder finishes. The drop point waits in sessionStorage
// until the map shows a new agent, then is saved as that agent's position.

const STORAGE_KEY = "agentum.map.agent-drop";
const MAX_AGE_MS = 60 * 60 * 1000;
const AGENT_PREFIX = "agent:";

export interface PendingAgentDrop {
  at: number;
  /** The agent node keys on the map when the builder opened. */
  known: string[];
  x: number;
  y: number;
}

export type AgentDropOutcome =
  | { kind: "expired" }
  | { kind: "place"; key: string; x: number; y: number }
  | { kind: "wait" };

/** Where the new agent goes: the first agent not known at drop time, or wait, or give up after an hour. */
export const resolveAgentDrop = (
  drop: PendingAgentDrop,
  nodeKeys: readonly string[],
  nowMs: number
): AgentDropOutcome => {
  if (nowMs - drop.at > MAX_AGE_MS) {
    return { kind: "expired" };
  }
  const key = nodeKeys.find(
    (candidate) =>
      candidate.startsWith(AGENT_PREFIX) && !drop.known.includes(candidate)
  );
  return key === undefined
    ? { kind: "wait" }
    : { key, kind: "place", x: drop.x, y: drop.y };
};

const isDrop = (value: unknown): value is PendingAgentDrop => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { at, known, x, y } = value as Record<string, unknown>;
  return (
    typeof at === "number" &&
    typeof x === "number" &&
    typeof y === "number" &&
    Array.isArray(known) &&
    known.every((item) => typeof item === "string")
  );
};

/** Parses what was stored, or null for anything else. */
export const parseAgentDrop = (raw: string | null): PendingAgentDrop | null => {
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    return isDrop(value) ? value : null;
  } catch {
    return null;
  }
};

export const rememberAgentDrop = (drop: PendingAgentDrop): void => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(drop));
  } catch {
    // Storage can be blocked. The agent then lands at its default place.
  }
};

export const recallAgentDrop = (): PendingAgentDrop | null => {
  try {
    return parseAgentDrop(sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
};

export const forgetAgentDrop = (): void => {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clear.
  }
};
