#!/usr/bin/env bun
// Adds Dan and Sam to the final Northbank workspace, and makes an empty first-day
// workspace, for the rail test and video. Idempotent. Prints the new org id.
import { createClerkClient } from "@clerk/backend";
import { parseEnv } from "node:util";

const ENV_LOCAL = `${import.meta.dir}/../../../apps/web/.env.local`;
const NORTHBANK_ORG = "org_3LPFGf6lplkL23SqKLA3YnkTI1L";
const { CLERK_SECRET_KEY: secretKey } = parseEnv(await Bun.file(ENV_LOCAL).text());
if (!secretKey?.startsWith("sk_test_")) {
  throw new Error("Expected the dev instance key in apps/web/.env.local");
}
const clerk = createClerkClient({ secretKey });

const userOf = async (email: string, firstName: string, lastName: string) => {
  const found = await clerk.users.getUserList({ emailAddress: [email] });
  return (
    found.data[0] ??
    (await clerk.users.createUser({
      emailAddress: [email],
      firstName,
      lastName,
      skipPasswordRequirement: true,
    }))
  );
};

const team = [
  ["dan@office.northbank.rockyshoreslabs.io", "Dan", "Hughes"],
  ["sam@office.northbank.rockyshoreslabs.io", "Sam", "Okafor"],
] as const;
for (const [email, first, last] of team) {
  const user = await userOf(email, first, last);
  const has = await clerk.users.getOrganizationMembershipList({ userId: user.id });
  if (!has.data.some((m) => m.organization.id === NORTHBANK_ORG)) {
    await clerk.organizations.createOrganizationMembership({
      organizationId: NORTHBANK_ORG,
      role: "org:member",
      userId: user.id,
    });
  }
  console.error(`${first}: ${user.id}`);
}

const fresh = await userOf("nina@firstday.rockyshoreslabs.io", "Nina", "Park");
const memberships = await clerk.users.getOrganizationMembershipList({ userId: fresh.id });
const orgId =
  memberships.data[0]?.organization.id ??
  (await clerk.organizations.createOrganization({ createdBy: fresh.id, name: "Firstday Studio" })).id;
console.log(orgId);
