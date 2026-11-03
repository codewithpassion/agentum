#!/usr/bin/env bun
// One-off for the Agentum v2 cutover: copies every organisation that has a
// workspace row, and its members, from the old Clerk instance to the new one,
// so build-clerk-id-map can then match them by email and name. Users are made
// without a password (nobody on the old instance has one) and with a verified
// email, so they sign in with Google or an email code. Their old id becomes the
// new user's external id. Dry run unless --apply. Safe to run twice: a user
// whose email exists, an org whose name exists and a membership that exists
// are left alone. Never deletes or changes anything on either instance.
// Usage, from apps/web:
//   bun run copy-clerk-users --db <sqlite file> [--from <env file>] [--to <env file>] [--apply]
// --db is a SQLite copy of the database (see build-clerk-id-map.ts); only
// `workspaces.clerk_org_id` is read. --from (default .env.production.local)
// holds the old instance's CLERK_SECRET_KEY, --to (default
// .env.agentum-production.local) the new one's. Without a --to key a dry run
// still prints the plan, as if the new instance were empty.
import { Database } from "bun:sqlite";
import { createClerkClient } from "@clerk/backend";
import { file } from "bun";
import { PRODUCTION_KEY_FILE, parseEnvFile } from "./agent-login-helpers.ts";
import {
  type CopyPlan,
  missingMembers,
  type OrgPlan,
  type PersonPlan,
  planCopy,
  type SourceOrg,
  type SourceUser,
} from "./copy-clerk-users-helpers.ts";

type Clerk = ReturnType<typeof createClerkClient>;

const readKey = async (name: string): Promise<string | undefined> => {
  const envFile = file(`${import.meta.dir}/../${name}`);
  if (!(await envFile.exists())) {
    return;
  }
  return parseEnvFile(await envFile.text()).CLERK_SECRET_KEY;
};

const memberUserIds = async (
  clerk: Clerk,
  organizationId: string
): Promise<{ role: string; userId: string }[]> => {
  const { data } = await clerk.organizations.getOrganizationMembershipList({
    limit: 100,
    organizationId,
  });
  return data.flatMap((membership) => {
    const userId = membership.publicUserData?.userId;
    return userId ? [{ role: membership.role, userId }] : [];
  });
};

const readSourceOrg = async (
  clerk: Clerk,
  organizationId: string
): Promise<SourceOrg> => {
  const [org, members] = await Promise.all([
    clerk.organizations.getOrganization({ organizationId }),
    memberUserIds(clerk, organizationId),
  ]);
  return {
    createdBy: org.createdBy ?? null,
    id: org.id,
    members,
    name: org.name,
  };
};

const readSourceUser = async (
  clerk: Clerk,
  userId: string
): Promise<SourceUser> => {
  const user = await clerk.users.getUser(userId);
  const primary =
    user.emailAddresses.find(
      (address) => address.id === user.primaryEmailAddressId
    ) ?? user.emailAddresses[0];
  if (primary === undefined) {
    throw new Error(`${userId} has no email address on the old instance.`);
  }
  return {
    email: primary.emailAddress,
    firstName: user.firstName,
    id: user.id,
    lastName: user.lastName,
  };
};

const readPlan = async (clerk: Clerk, orgIds: string[]): Promise<CopyPlan> => {
  const orgs = await Promise.all(orgIds.map((id) => readSourceOrg(clerk, id)));
  const userIds = new Set(
    orgs.flatMap((org) => org.members.map((member) => member.userId))
  );
  const users = await Promise.all(
    [...userIds].map((id) => readSourceUser(clerk, id))
  );
  return planCopy(orgs, users);
};

const one = (ids: string[], what: string): string | undefined => {
  if (ids.length > 1) {
    throw new Error(`${ids.length} ${what} on the new instance. Fix by hand.`);
  }
  return ids[0];
};

interface Target {
  apply: boolean;
  clerk: Clerk | undefined;
}

/** Finds or makes the person on the new instance. Returns [new id, log line]. */
const ensureUser = async (
  target: Target,
  person: PersonPlan
): Promise<[string, string]> => {
  const { clerk } = target;
  if (clerk === undefined) {
    return [
      `<new id of ${person.email}>`,
      `would create user ${person.email} (from ${person.oldId})`,
    ];
  }
  const { data } = await clerk.users.getUserList({
    emailAddress: [person.email],
  });
  const found = one(
    data.map((user) => user.id),
    `users with ${person.email}`
  );
  if (found) {
    return [found, `EXISTS  user ${person.email} ${found}`];
  }
  if (!target.apply) {
    return [
      `<new id of ${person.email}>`,
      `would create user ${person.email} (from ${person.oldId})`,
    ];
  }
  const created = await clerk.users.createUser({
    emailAddress: [person.email],
    externalId: person.oldId,
    firstName: person.firstName ?? undefined,
    lastName: person.lastName ?? undefined,
    skipPasswordRequirement: true,
  });
  return [created.id, `CREATED user ${person.email} ${created.id}`];
};

const findOrg = async (
  clerk: Clerk,
  name: string
): Promise<string | undefined> => {
  const { data } = await clerk.organizations.getOrganizationList({
    limit: 100,
    query: name,
  });
  return one(
    data.filter((org) => org.name === name).map((org) => org.id),
    `organisations named "${name}"`
  );
};

/** Finds or makes the org and its memberships. Returns the log lines. */
const ensureOrg = async (
  target: Target,
  org: OrgPlan,
  newIdOf: (oldId: string) => string
): Promise<string[]> => {
  const { clerk } = target;
  const creator = newIdOf(org.creatorOldId);
  let orgId = clerk ? await findOrg(clerk, org.name) : undefined;
  let existing = new Set([creator]);
  let line: string;

  if (clerk && orgId) {
    line = `EXISTS  org "${org.name}" ${orgId}`;
    const members = await memberUserIds(clerk, orgId);
    existing = new Set(members.map((member) => member.userId));
  } else if (clerk && target.apply) {
    orgId = (
      await clerk.organizations.createOrganization({
        createdBy: creator,
        name: org.name,
      })
    ).id;
    line = `CREATED org "${org.name}" ${orgId} (from ${org.oldId})`;
  } else {
    line = `would create org "${org.name}" (from ${org.oldId}), created by ${creator} as org:admin`;
  }

  const added = await Promise.all(
    missingMembers(org, newIdOf, existing).map(async (member) => {
      const what = `${member.userId} to "${org.name}" as ${member.role}`;
      if (!(clerk && orgId && target.apply)) {
        return `would add ${what}`;
      }
      await clerk.organizations.createOrganizationMembership({
        organizationId: orgId,
        role: member.role,
        userId: member.userId,
      });
      return `ADDED   ${what}`;
    })
  );
  return [line, ...added];
};

const main = async () => {
  const argv = process.argv.slice(2);
  const arg = (flag: string) => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const apply = argv.includes("--apply");
  const dbPath = arg("--db");
  if (!dbPath) {
    throw new Error("Pass --db <sqlite file>.");
  }
  const fromFile = arg("--from") ?? ".env.production.local";
  const toFile = arg("--to") ?? PRODUCTION_KEY_FILE;
  const oldKey = await readKey(fromFile);
  const newKey = await readKey(toFile);
  if (!oldKey?.startsWith("sk_")) {
    throw new Error(`Need CLERK_SECRET_KEY in apps/web/${fromFile}.`);
  }
  if (
    newKey !== undefined &&
    (newKey === oldKey || !newKey.startsWith("sk_"))
  ) {
    throw new Error(
      `CLERK_SECRET_KEY in apps/web/${toFile} must be the new instance's key.`
    );
  }
  if (apply && newKey === undefined) {
    throw new Error(`--apply needs CLERK_SECRET_KEY in apps/web/${toFile}.`);
  }

  const orgIds = new Database(dbPath, { readonly: true })
    .query<{ clerk_org_id: string }, []>(
      "SELECT clerk_org_id FROM workspaces ORDER BY clerk_org_id"
    )
    .all()
    .map((row) => row.clerk_org_id);
  const plan = await readPlan(createClerkClient({ secretKey: oldKey }), orgIds);
  const target: Target = {
    apply,
    clerk: newKey ? createClerkClient({ secretKey: newKey }) : undefined,
  };

  // Users first: an org needs its creator's new id.
  const users = await Promise.all(
    plan.people.map((person) => ensureUser(target, person))
  );
  const newIds = new Map(
    plan.people.map((person, index) => [person.oldId, users[index]?.[0]])
  );
  const newIdOf = (oldId: string): string => {
    const id = newIds.get(oldId);
    if (id === undefined) {
      throw new Error(`No new id for ${oldId}.`);
    }
    return id;
  };
  const orgs = await Promise.all(
    plan.orgs.map((org) => ensureOrg(target, org, newIdOf))
  );

  for (const line of [...users.map(([, text]) => text), ...orgs.flat()]) {
    console.log(line);
  }
  console.log(
    `${plan.orgs.length} org(s), ${plan.people.length} user(s).${apply ? "" : " Dry run: nothing written. Pass --apply to write."}`
  );
};

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "copy-clerk-users failed"
  );
  process.exit(1);
}
