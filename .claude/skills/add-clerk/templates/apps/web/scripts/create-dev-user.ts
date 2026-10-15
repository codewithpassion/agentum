#!/usr/bin/env bun
// Creates (or updates) the Clerk user used by the one-click dev login
// (see /api/dev-login), gives it a dev organisation, and adds that
// organisation to ALLOWED_ORG_IDS in apps/web/.env.local. Reads
// CLERK_SECRET_KEY / DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD from
// apps/web/.env.local.
import { createClerkClient } from "@clerk/backend";
import { file, write } from "bun";

const secretKey = process.env.CLERK_SECRET_KEY;
const email = process.env.DEV_LOGIN_EMAIL;
const password = process.env.DEV_LOGIN_PASSWORD;

if (!secretKey) {
  throw new Error("CLERK_SECRET_KEY is not set in apps/web/.env.local");
}
if (!(email && password)) {
  throw new Error(
    "DEV_LOGIN_EMAIL and DEV_LOGIN_PASSWORD must be set in apps/web/.env.local"
  );
}

const clerkClient = createClerkClient({ secretKey });

const existing = await clerkClient.users.getUserList({ emailAddress: [email] });
const [user] = existing.data;

let userId: string;
if (user) {
  await clerkClient.users.updateUser(user.id, {
    password,
    skipPasswordChecks: true,
  });
  userId = user.id;
  console.log(`Updated password for existing dev user ${email} (${user.id}).`);
} else {
  const created = await clerkClient.users.createUser({
    emailAddress: [email],
    firstName: "Dev",
    lastName: "User",
    password,
    skipPasswordChecks: true,
  });
  userId = created.id;
  console.log(`Created dev user ${email} (${created.id}).`);
}

const memberships = await clerkClient.users.getOrganizationMembershipList({
  userId,
});
const [membership] = memberships.data;
const orgId = membership
  ? membership.organization.id
  : (
      await clerkClient.organizations.createOrganization({
        createdBy: userId,
        name: "Dev Workspace",
      })
    ).id;

console.log(
  membership
    ? `Dev user already belongs to organisation ${orgId}.`
    : `Created organisation Dev Workspace (${orgId}).`
);

const envPath = `${import.meta.dir}/../.env.local`;
const envFile = file(envPath);
const envText = (await envFile.exists()) ? await envFile.text() : "";
const key = "ALLOWED_ORG_IDS=";
const lines = envText.split("\n");
const current = lines.find((line) => line.startsWith(key));

if (current === undefined) {
  const prefix =
    envText === "" || envText.endsWith("\n") ? envText : `${envText}\n`;
  await write(envPath, `${prefix}${key}${orgId}\n`);
  console.log(`Added ${key}${orgId} to apps/web/.env.local.`);
} else {
  const ids = current.slice(key.length).split(",").filter(Boolean);
  if (ids.includes(orgId)) {
    console.log(`${orgId} is already in ALLOWED_ORG_IDS.`);
  } else {
    const next = [...ids, orgId].join(",");
    const updated = lines.map((line) =>
      line.startsWith(key) ? `${key}${next}` : line
    );
    await write(envPath, updated.join("\n"));
    console.log(`Added ${orgId} to ALLOWED_ORG_IDS in apps/web/.env.local.`);
  }
}
