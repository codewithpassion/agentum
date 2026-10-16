// Clerk, as the Slack link flow needs it: find the user who owns an email
// address, and check they belong to the workspace's organisation. Kept apart
// from compose.ts so that file stays free of Clerk imports and bun can test it.
import { createClerkClient } from "@clerk/backend";
import type { SlackDirectory } from "@repo/services/slack";
import { clerkOrgMemberCheck } from "./mcp/clerk-membership.ts";

/** Users Clerk returns for one email address; more than one would be a data problem. */
const EMAIL_MATCH_LIMIT = 2;

export const clerkSlackDirectory = (secretKey: string): SlackDirectory => {
  // Built on first use: most requests never look a Slack sender up.
  let clerk: ReturnType<typeof createClerkClient> | undefined;
  return {
    findUserIdByEmail: async (email) => {
      clerk ??= createClerkClient({ secretKey });
      const wanted = email.trim().toLowerCase();
      const { data } = await clerk.users.getUserList({
        emailAddress: [wanted],
        limit: EMAIL_MATCH_LIMIT,
      });
      // Only an address Clerk has verified proves the person owns it.
      const matches = data.filter((user) =>
        user.emailAddresses.some(
          (address) =>
            address.emailAddress.toLowerCase() === wanted &&
            address.verification?.status === "verified"
        )
      );
      const [only] = matches;
      return matches.length === 1 && only ? only.id : null;
    },
    isOrgMember: (userId, clerkOrgId) =>
      clerkOrgMemberCheck(secretKey)(userId, clerkOrgId),
  };
};
