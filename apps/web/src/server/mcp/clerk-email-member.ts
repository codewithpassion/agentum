// Turns a verified email into the Clerk user id of a member of one Clerk
// organisation. Lookups are not cached here: each call asks Clerk afresh,
// and the membership check underneath keeps its own short-lived cache.
import { createClerkClient } from "@clerk/backend";
import { clerkOrgMemberCheck } from "./clerk-membership.ts";

/** The fields of a Clerk user this lookup reads. */
export interface ClerkEmailUser {
  emailAddresses: Array<{
    emailAddress: string;
    verification: { status: string } | null;
  }>;
  id: string;
}

/** A Clerk user id for `email` when that user is in `clerkOrgId`, else null. */
export type EmailMemberLookup = (
  email: string,
  clerkOrgId: string
) => Promise<string | null>;

/** Clerk users to read per email; more than one match is refused anyway. */
const USER_LIMIT = 5;

export const emailMemberLookup =
  ({
    findUsers,
    isOrgMember,
  }: {
    findUsers: (email: string) => Promise<ClerkEmailUser[]>;
    isOrgMember: (userId: string, clerkOrgId: string) => Promise<boolean>;
  }): EmailMemberLookup =>
  async (email, clerkOrgId) => {
    const wanted = email.trim();
    if (wanted === "") {
      return null;
    }
    const folded = wanted.toLowerCase();
    const users = await findUsers(wanted);
    const ids = new Set(
      users
        .filter((user) =>
          user.emailAddresses.some(
            (address) =>
              address.verification?.status === "verified" &&
              address.emailAddress.toLowerCase() === folded
          )
        )
        .map((user) => user.id)
    );
    const matched = [...ids];
    const [id] = matched;
    if (matched.length !== 1 || id === undefined) {
      return null;
    }
    return (await isOrgMember(id, clerkOrgId)) ? id : null;
  };

export const clerkEmailMemberLookup = (
  secretKey: string
): EmailMemberLookup => {
  let clerk: ReturnType<typeof createClerkClient> | undefined;
  return emailMemberLookup({
    findUsers: async (email) => {
      clerk ??= createClerkClient({ secretKey });
      const { data } = await clerk.users.getUserList({
        emailAddress: [email],
        limit: USER_LIMIT,
      });
      return data.map((user) => ({
        emailAddresses: user.emailAddresses.map((address) => ({
          emailAddress: address.emailAddress,
          verification: address.verification
            ? { status: address.verification.status }
            : null,
        })),
        id: user.id,
      }));
    },
    isOrgMember: clerkOrgMemberCheck(secretKey),
  });
};
