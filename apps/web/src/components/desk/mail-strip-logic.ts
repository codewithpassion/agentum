/** One agent's mail counts for today, as `mailToday` returns them. */
export interface MailCount {
  address: string;
  agentId: string;
  held: number;
  in: number;
}

/** The rows for one agent, or every row when no agent is selected. */
export const mailRowsFor = (
  rows: readonly MailCount[],
  agentId: string | undefined
): readonly MailCount[] =>
  agentId === undefined ? rows : rows.filter((row) => row.agentId === agentId);

/** "1 in", "3 in". */
export const inCountText = (count: number): string => `${count} in`;

/** "1 held for approval", "2 held for approval". */
export const heldCountText = (count: number): string =>
  `${count} held for approval`;
