#!/usr/bin/env bun
// Fills in the member snapshots migration 0012 could not: it made every Clerk
// user already present in the data an owner of the default workspace, but SQL
// has no way to ask Clerk for an email. This does, once, for every membership
// still holding the empty-string placeholder.
//
// Idempotent: a row with an email is never touched again.
//
//   bun run backfill-workspace-members     (from apps/web)
import { createClerkClient } from "@clerk/backend";
import { d1Execute, requireDefaultWorkspace, sqlValue } from "./d1";

interface PendingMember {
  clerk_user_id: string;
  id: string;
}

const secretKey = process.env.CLERK_SECRET_KEY;

if (!secretKey) {
  throw new Error("CLERK_SECRET_KEY is not set in apps/web/.env.local");
}

await requireDefaultWorkspace();

const clerkClient = createClerkClient({ secretKey });

const pending = await d1Execute<PendingMember>(
  "SELECT clerk_user_id, id FROM workspace_members WHERE email = ''"
);

if (pending.length === 0) {
  console.log("Every workspace member already has an email. Nothing to do.");
}

for (const member of pending) {
  // biome-ignore lint/performance/noAwaitInLoops: one Clerk call at a time, on purpose - this is a one-shot script and the user list is tiny.
  const user = await clerkClient.users
    .getUser(member.clerk_user_id)
    .catch(() => null);

  const email =
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses.at(0)?.emailAddress;

  if (!email) {
    console.warn(
      `No Clerk user (or no email) for ${member.clerk_user_id}; leaving the membership blank.`
    );
    continue;
  }

  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ");

  await d1Execute(
    `UPDATE workspace_members SET email = ${sqlValue(email)}, image_url = ${sqlValue(user?.imageUrl ?? null)}, name = ${sqlValue(name || null)} WHERE id = ${sqlValue(member.id)}`
  );
  console.log(`Filled in ${email} for member ${member.id}.`);
}
