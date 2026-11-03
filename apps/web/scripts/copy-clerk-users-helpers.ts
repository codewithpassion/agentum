/**
 * Pure helpers for copy-clerk-users.ts, which copies the organisations that
 * have a workspace row, and their members, from one Clerk instance to another
 * (the Agentum v2 cutover: the shared production instance to the Agentum
 * production instance). No I/O, no Clerk calls here. Tested in
 * copy-clerk-users.test.ts.
 */

export interface SourceUser {
  email: string;
  firstName: string | null;
  id: string;
  lastName: string | null;
}

export interface SourceMember {
  role: string;
  userId: string;
}

export interface SourceOrg {
  createdBy: string | null;
  id: string;
  members: SourceMember[];
  name: string;
}

/** One person to have on the new instance. */
export interface PersonPlan {
  email: string;
  firstName: string | null;
  lastName: string | null;
  oldId: string;
}

export interface OrgPlan {
  /** The old user id of the member who creates the org (becomes its admin). */
  creatorOldId: string;
  members: SourceMember[];
  name: string;
  oldId: string;
}

export interface CopyPlan {
  orgs: OrgPlan[];
  people: PersonPlan[];
}

const ADMIN = "org:admin";

/**
 * Picks who creates the org on the new instance: the old creator if still an
 * admin member, otherwise the first admin, otherwise the first member. Clerk
 * makes the creator an admin, so an org with no member can't be copied.
 */
const creatorOf = (org: SourceOrg): string => {
  const admins = org.members.filter((member) => member.role === ADMIN);
  const creator =
    admins.find((member) => member.userId === org.createdBy) ??
    admins[0] ??
    org.members[0];
  if (creator === undefined) {
    throw new Error(`${org.id} ("${org.name}") has no members to copy.`);
  }
  return creator.userId;
};

/**
 * Turns the orgs and their users, read from the old instance, into what must
 * exist on the new one. Throws when a member has no user record, or when two
 * orgs share a name (build-clerk-id-map matches orgs by name).
 */
export const planCopy = (orgs: SourceOrg[], users: SourceUser[]): CopyPlan => {
  const byId = new Map(users.map((user) => [user.id, user]));
  const names = new Set<string>();
  const people = new Map<string, PersonPlan>();
  const plans: OrgPlan[] = [];

  for (const org of orgs) {
    if (names.has(org.name)) {
      throw new Error(
        `Two organisations are named "${org.name}". Rename one first: the id map matches organisations by name.`
      );
    }
    names.add(org.name);
    for (const member of org.members) {
      const user = byId.get(member.userId);
      if (user === undefined) {
        throw new Error(
          `${member.userId}, a member of ${org.id}, has no user record.`
        );
      }
      people.set(user.id, {
        email: user.email.toLowerCase(),
        firstName: user.firstName,
        lastName: user.lastName,
        oldId: user.id,
      });
    }
    plans.push({
      creatorOldId: creatorOf(org),
      members: org.members,
      name: org.name,
      oldId: org.id,
    });
  }

  return {
    orgs: plans,
    people: [...people.values()].sort((a, b) => a.email.localeCompare(b.email)),
  };
};

/**
 * The memberships still to add to an org on the new instance: every planned
 * member, by new user id, minus those already there. The creator is already
 * there once the org exists.
 */
export const missingMembers = (
  org: OrgPlan,
  newIdOf: (oldId: string) => string,
  existingUserIds: ReadonlySet<string>
): { role: string; userId: string }[] =>
  org.members
    .map((member) => ({ role: member.role, userId: newIdOf(member.userId) }))
    .filter((member) => !existingUserIds.has(member.userId));
