/** The radio value for "Nobody"; agent ids are never this. */
export const NOBODY_VALUE = "__nobody__";

export interface HandToAgent {
  id: string;
  name: string;
}

/** The radio value for the agent an artifact is handed to (null: nobody). */
export function handToValue(agentId: string | null): string {
  return agentId ?? NOBODY_VALUE;
}

/** The `handTo` argument for a radio value. */
export function handToAgentId(value: string): string | null {
  return value === NOBODY_VALUE ? null : value;
}
