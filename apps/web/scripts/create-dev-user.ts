#!/usr/bin/env bun
// Creates (or updates) the Clerk user used by the one-click dev login
// (see /api/dev-login), and makes sure it owns the default workspace - without
// a membership the dev login lands on a signed-in user who belongs nowhere.
// Reads CLERK_SECRET_KEY / DEV_LOGIN_EMAIL / DEV_LOGIN_PASSWORD from
// apps/web/.env.local.
import { createClerkClient } from "@clerk/backend";
import { DEFAULT_WORKSPACE_ID } from "#/modules/workspaces/service";
import { d1Execute, requireDefaultWorkspace, sqlValue } from "./d1";

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

await requireDefaultWorkspace();

// The snapshot is refreshed on every run; the role is not, so a dev user
// demoted by hand stays demoted.
await d1Execute(
  `INSERT INTO workspace_members (clerk_user_id, email, id, name, role, workspace_id)
   VALUES (${sqlValue(userId)}, ${sqlValue(email)}, ${sqlValue(crypto.randomUUID())}, 'Dev User', 'owner', ${sqlValue(DEFAULT_WORKSPACE_ID)})
   ON CONFLICT (workspace_id, clerk_user_id) DO UPDATE SET email = excluded.email, name = excluded.name`
);
console.log(`Dev user owns the ${DEFAULT_WORKSPACE_ID} workspace.`);
