#!/usr/bin/env bun
import { parseEnv } from "node:util";
// Creates the UX review persona and its Clerk organisation on the instance
// staging uses (the dev instance), then prints the org id for `bun run add-workspace --env staging`.
// Idempotent. Run from this folder: bun provision-sim.ts
import { createClerkClient } from "@clerk/backend";

const ENV_LOCAL = `${import.meta.dir}/../../../apps/web/.env.local`;
const EMAIL = "ux-sim@rockyshoreslabs.io";
const ORG_NAME = "Outside Senders (UX review sim)";

const { CLERK_SECRET_KEY: secretKey } = parseEnv(
  await Bun.file(ENV_LOCAL).text()
);
if (!secretKey?.startsWith("sk_test_")) {
  throw new Error("Expected the dev instance key in apps/web/.env.local");
}
const clerk = createClerkClient({ secretKey });

const existing = await clerk.users.getUserList({ emailAddress: [EMAIL] });
const user =
  existing.data[0] ??
  (await clerk.users.createUser({
    emailAddress: [EMAIL],
    firstName: "Sim",
    lastName: "Sender",
    skipPasswordRequirement: true,
  }));

const memberships = await clerk.users.getOrganizationMembershipList({
  userId: user.id,
});
const orgId =
  memberships.data[0]?.organization.id ??
  (
    await clerk.organizations.createOrganization({
      createdBy: user.id,
      name: ORG_NAME,
    })
  ).id;

console.log(JSON.stringify({ orgId, userId: user.id }));
