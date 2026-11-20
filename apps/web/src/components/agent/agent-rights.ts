// Pure rules on who may manage an agent. No React, no calls.

/**
 * Whether the person may change the agent's apps, allowed tools, sign-in mode,
 * own credential, Slack app and secret grants: an org admin, or the agent's
 * owner. The owner is `ownerUserId`, or `createdBy` when no owner is set.
 */
export const canManageAgentKeys = ({
  agent,
  isAdmin,
  userId,
}: {
  agent: { createdBy: string; ownerUserId: string | null };
  isAdmin: boolean;
  userId: string | null | undefined;
}): boolean => {
  if (isAdmin) {
    return true;
  }
  if (!userId) {
    return false;
  }
  return userId === (agent.ownerUserId ?? agent.createdBy);
};
