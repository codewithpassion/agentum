import type { WorkspaceMember } from "@repo/db/shared";

/** Who the agent asks: its owner and an optional backup, both Clerk user ids. */
export interface AskOwners {
  backupUserId: string | null;
  ownerUserId: string;
}

/** One edit from the owner or the backup select. */
export type AskChange =
  | { ownerUserId: string }
  | { backupUserId: string | null };

/** The owner's user id: `ownerUserId`, or `createdBy` when that is null. */
export function ownerIdOf(agent: {
  createdBy: string;
  ownerUserId: string | null;
}): string {
  return agent.ownerUserId ?? agent.createdBy;
}

/** The member who owns the agent, or null when that user has left the organisation. */
export function effectiveOwner(
  agent: { createdBy: string; ownerUserId: string | null },
  members: WorkspaceMember[]
): WorkspaceMember | null {
  const id = ownerIdOf(agent);
  return members.find((member) => member.userId === id) ?? null;
}

/** The members who can back up the owner. The owner never can. */
export function backupChoices(
  members: WorkspaceMember[],
  ownerUserId: string
): WorkspaceMember[] {
  return members.filter((member) => member.userId !== ownerUserId);
}

/** The owner and backup selects only make sense with a real choice to make. */
export function canPick(members: WorkspaceMember[]): boolean {
  return members.length > 1;
}

/**
 * The owners to save after one change. A backup that the new owner cannot
 * have (the owner itself, or someone who is not a member) is cleared.
 */
export function nextOwners({
  change,
  current,
  members,
}: {
  change: AskChange;
  current: AskOwners;
  members: WorkspaceMember[];
}): AskOwners {
  const ownerUserId =
    "ownerUserId" in change ? change.ownerUserId : current.ownerUserId;
  const wanted =
    "backupUserId" in change ? change.backupUserId : current.backupUserId;
  const offered =
    wanted !== null &&
    backupChoices(members, ownerUserId).some(
      (member) => member.userId === wanted
    );
  return { backupUserId: offered ? wanted : null, ownerUserId };
}
