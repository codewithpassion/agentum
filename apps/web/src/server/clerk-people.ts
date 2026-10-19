// Clerk, as the Log needs it: the name and primary email behind user ids. Kept
// apart from compose.ts so that file stays free of Clerk imports and bun can test it.
import { createClerkClient } from "@clerk/backend";
import type { PeopleLookup } from "@repo/services/events";

/** The parts of a Clerk user the Log reads. A Clerk `User` fits this structurally. */
export interface ClerkPersonSource {
  emailAddresses: Array<{ id: string; emailAddress: string }>;
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddressId: string | null;
}

/** A name and an email for one person, either may be missing. */
export interface ClerkPersonName {
  email: string | null;
  name: string | null;
}

/** The name and primary email of a Clerk user. The primary address falls back to the first one. */
export const toPersonName = (user: ClerkPersonSource): ClerkPersonName => {
  const name = [user.firstName, user.lastName]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join(" ");
  const primary = user.emailAddresses.find(
    (address) => address.id === user.primaryEmailAddressId
  );
  return {
    email: (primary ?? user.emailAddresses[0])?.emailAddress ?? null,
    name: name.length > 0 ? name : null,
  };
};

export const clerkPeople = (secretKey: string): PeopleLookup => {
  // Built on first use: most requests never open the Log.
  let clerk: ReturnType<typeof createClerkClient> | undefined;
  return async (userIds) => {
    // An empty `userId` filter would list every user in the instance.
    if (userIds.length === 0) {
      return new Map();
    }
    clerk ??= createClerkClient({ secretKey });
    const { data } = await clerk.users.getUserList({
      limit: userIds.length,
      userId: [...userIds],
    });
    return new Map(data.map((user) => [user.id, toPersonName(user)]));
  };
};
