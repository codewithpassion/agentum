#!/usr/bin/env bun
// Creates (or updates) the Clerk user used by the one-click dev login
// (see /api/dev-login). Reads CLERK_SECRET_KEY / DEV_LOGIN_EMAIL /
// DEV_LOGIN_PASSWORD from apps/web/.env.local.
import { createClerkClient } from "@clerk/backend";

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

if (user) {
  await clerkClient.users.updateUser(user.id, {
    password,
    skipPasswordChecks: true,
  });
  console.log(`Updated password for existing dev user ${email} (${user.id}).`);
} else {
  const created = await clerkClient.users.createUser({
    emailAddress: [email],
    firstName: "Dev",
    lastName: "User",
    password,
    skipPasswordChecks: true,
  });
  console.log(`Created dev user ${email} (${created.id}).`);
}
