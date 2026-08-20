import { createClerkClient } from "@clerk/backend";

/**
 * Members are added by email, so this module needs to ask Clerk who owns one.
 * It goes through an interface for the same reason `modules/anthropic` wraps
 * its SDK: the Clerk id a lookup returns is written straight into
 * `workspace_members.clerk_user_id` and must never travel any further, and a
 * test can hand the routes a directory without a network.
 */
export interface DirectoryUser {
  /** Server-side only: goes into `workspace_members`, never into a response. */
  clerkUserId: string;
  email: string;
  imageUrl: string | null;
  name: string | null;
}

export interface ClerkDirectory {
  /** The add-a-member and search lookup; undefined means "no Clerk account". */
  findUserByEmail: (email: string) => Promise<DirectoryUser | undefined>;
  /** Refreshes a member snapshot; undefined once the Clerk user is gone. */
  getUser: (clerkUserId: string) => Promise<DirectoryUser | undefined>;
}

interface ClerkUser {
  emailAddresses: { emailAddress: string }[];
  firstName: string | null;
  id: string;
  imageUrl?: string;
  lastName: string | null;
  primaryEmailAddress: { emailAddress: string } | null;
}

const toDirectoryUser = (user: ClerkUser): DirectoryUser | undefined => {
  const [firstEmail] = user.emailAddresses;
  const email = user.primaryEmailAddress
    ? user.primaryEmailAddress.emailAddress
    : firstEmail?.emailAddress;
  if (!email) {
    return;
  }
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ");
  return {
    clerkUserId: user.id,
    email,
    imageUrl: user.imageUrl ?? null,
    name: name || null,
  };
};

export const clerkDirectoryFromEnv = (env: Env): ClerkDirectory => {
  const client = createClerkClient({ secretKey: env.CLERK_SECRET_KEY });

  return {
    async findUserByEmail(email) {
      const { data } = await client.users.getUserList({
        emailAddress: [email],
      });
      const [user] = data;
      return user ? toDirectoryUser(user) : undefined;
    },

    async getUser(clerkUserId) {
      const user = await client.users.getUser(clerkUserId).catch(() => null);
      return user ? toDirectoryUser(user) : undefined;
    },
  };
};
