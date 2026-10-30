import type { RouterOutputs } from "#/integrations/trpc/types";

type AgentListItem = RouterOutputs["agents"]["list"][number];
type OverviewRow = RouterOutputs["agents"]["overview"][number];
type Members = RouterOutputs["members"]["list"];

/** The fields the table reads to work out who an agent asks. */
export type AgentAskRef = Pick<
  AgentListItem,
  "id" | "ownerUserId" | "createdBy"
>;

/** One piece of the "Doing now" cell. Waiting is the stronger signal. */
export interface DoingSegment {
  strong: boolean;
  text: string;
}

export interface AgentTableRow<T extends AgentAskRef = AgentListItem> {
  agent: T;
  asked: string;
  doing: DoingSegment[];
  tasksThisWeek: number;
}

/**
 * The name of whoever the agent asks. `members` is null when the lookup
 * failed, so the owner cannot be named.
 */
export const askedName = (
  agent: AgentAskRef,
  members: Members | null
): string => {
  if (members === null) {
    return "Unknown";
  }
  const owner = agent.ownerUserId ?? agent.createdBy;
  return members.find((member) => member.userId === owner)?.name ?? "Nobody";
};

/** Waiting first, then working. An agent with neither is "Quiet". */
export const doingNow = (
  row: Pick<OverviewRow, "waiting" | "working"> | undefined
): DoingSegment[] => {
  const waiting = row?.waiting ?? 0;
  const working = row?.working ?? 0;
  const segments: DoingSegment[] = [];
  if (waiting > 0) {
    segments.push({ strong: true, text: `${waiting} waiting` });
  }
  if (working > 0) {
    segments.push({ strong: false, text: `${working} working` });
  }
  return segments.length > 0 ? segments : [{ strong: false, text: "Quiet" }];
};

/** One row per agent, in the order of `agents`. No overview row means zeros. */
export const rowsOf = <T extends AgentAskRef>(
  agents: readonly T[],
  overview: readonly OverviewRow[],
  members: Members | null
): AgentTableRow<T>[] => {
  const byAgent = new Map(overview.map((row) => [row.agentId, row]));
  return agents.map((agent) => {
    const row = byAgent.get(agent.id);
    return {
      agent,
      asked: askedName(agent, members),
      doing: doingNow(row),
      tasksThisWeek: row?.tasksThisWeek ?? 0,
    };
  });
};
