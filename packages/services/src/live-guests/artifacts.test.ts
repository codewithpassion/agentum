import { expect, test } from "bun:test";
import { artifacts } from "@repo/db/schema/artifacts";
import { events } from "@repo/db/schema/events";
import {
  artifactMembers,
  guestIdentities,
  guestSessions,
} from "@repo/db/schema/live-artifacts";
import { eq } from "drizzle-orm";
import { harness } from "../artifacts/test-harness.ts";
import { hashToken } from "../crypto.ts";
import { createGuestArtifacts } from "./artifacts.ts";
import { newGuestSessionToken } from "./security.ts";

const setup = async () => {
  const h = harness();
  const at = new Date("2026-10-27T00:00:00Z");
  const expiry = "2026-10-28T00:00:00.000Z";
  const id = crypto.randomUUID();
  await h.db.insert(artifacts).values({
    audience: "workspace",
    createdAt: at.toISOString(),
    createdById: "u1",
    createdByKind: "user",
    id,
    kind: "document",
    ownerUserId: "u1",
    title: "Guest",
    updatedAt: at.toISOString(),
    workspaceId: "w1",
  });
  await h.db.insert(guestIdentities).values({
    createdAt: at.toISOString(),
    displayName: "Guest",
    email: "guest@example.com",
    id: "g1",
    workspaceId: "w1",
  });
  await h.db.insert(artifactMembers).values({
    artifactId: id,
    createdAt: at.toISOString(),
    createdBy: "u1",
    expiresAt: expiry,
    guestId: "g1",
    id: "m1",
    principalKind: "guest",
    role: "commenter",
    workspaceId: "w1",
  });
  const token = await newGuestSessionToken();
  await h.db.insert(guestSessions).values({
    createdAt: at.toISOString(),
    expiresAt: expiry,
    guestId: "g1",
    id: "gs1",
    lastUsedAt: at.toISOString(),
    tokenHash: token.hash,
    workspaceId: "w1",
  });
  let off = false;
  let beforeWrite: (() => Promise<void>) | undefined;
  const service = createGuestArtifacts({
    ...h,
    atomic: async (statements) => {
      await beforeWrite?.();
      await h.atomic(statements);
    },
    clock: { now: () => at, sleep: () => Promise.resolve() },
    events: h.events,
    guestsOff: () => off,
  });
  return {
    ...h,
    before: (fn: () => Promise<void>) => {
      beforeWrite = fn;
    },
    credential: {
      artifactId: id,
      sessionToken: token.token,
      workspaceId: "w1",
    },
    service,
    setOff: () => {
      off = true;
    },
  };
};
test("commenter comments/resolves; viewer, cross artifact and emergency switch refuse", async () => {
  const h = await setup();
  const comment = await h.service.comment(h.credential, {
    body: "Guest comment",
  });
  expect(
    (await h.service.threads(h.credential))[0]?.comments[0]?.authorKind
  ).toBe("guest");
  await expect(
    h.service.comment(
      { ...h.credential, artifactId: crypto.randomUUID() },
      { body: "No" }
    )
  ).rejects.toThrow();
  await expect(
    h.service.resolve(
      { ...h.credential, artifactId: crypto.randomUUID() },
      comment.threadId
    )
  ).rejects.toThrow();
  await h.service.resolve(h.credential, comment.threadId);
  expect(
    (
      await h.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.comment_created"))
    ).length
  ).toBe(1);
  await h.db
    .update(artifactMembers)
    .set({ role: "viewer" })
    .where(eq(artifactMembers.id, "m1"));
  await expect(
    h.service.comment(h.credential, { body: "No" })
  ).rejects.toThrow();
  h.setOff();
  await expect(h.service.threads(h.credential)).rejects.toThrow();
});
test("write-time revocation refuses without comment or audit", async () => {
  const h = await setup();
  h.before(async () => {
    await h.db
      .update(artifactMembers)
      .set({ revokedAt: "2026-10-27T00:00:00.000Z" })
      .where(eq(artifactMembers.id, "m1"));
  });
  await expect(
    h.service.comment(h.credential, { body: "No" })
  ).rejects.toThrow();
  expect(
    (
      await h.db
        .select()
        .from(events)
        .where(eq(events.type, "artifact.comment_created"))
    ).length
  ).toBe(0);
});
test("room reference survives rotation but not signout", async () => {
  const h = await setup();
  const ref = await h.service.sessionReference(h.credential);
  expect(ref?.sessionId).toBe("gs1");
  const input = {
    artifactId: h.credential.artifactId,
    sessionId: "gs1",
    workspaceId: "w1",
  };
  await h.db
    .update(guestSessions)
    .set({ tokenHash: await hashToken("rotated") })
    .where(eq(guestSessions.id, "gs1"));
  expect((await h.service.resolveReference(input))?.guestId).toBe("g1");
  await h.db.delete(guestSessions).where(eq(guestSessions.id, "gs1"));
  expect(await h.service.resolveReference(input)).toBeNull();
});

test("guest transcript selects only the exact non-private artifact-origin session", async () => {
  const h = await setup();
  const { sessions } = await import("@repo/db/schema/sessions");
  await h.db.insert(sessions).values([
    {
      actorId: "u1",
      actorKind: "user",
      agentId: "a1",
      createdAt: "2026-10-27T00:00:00.000Z",
      externalKey: h.credential.artifactId,
      id: "guest-artifact-thread",
      origin: "artifact",
      workspaceId: "w1",
    },
    {
      actorId: "u1",
      actorKind: "user",
      agentId: "a1",
      createdAt: "2026-10-27T00:00:00.000Z",
      externalKey: h.credential.artifactId,
      id: "not-artifact-thread",
      origin: "ui",
      workspaceId: "w1",
    },
  ]);
  await h.db.insert(events).values([
    {
      actorId: "g1",
      actorKind: "guest",
      createdAt: "2026-10-27T00:00:00.000Z",
      id: "event-artifact",
      payload: '{"text":"Visible","actorDisplay":{"name":"Forged owner"}}',
      sessionId: "guest-artifact-thread",
      type: "message.user",
      workspaceId: "w1",
    },
    {
      actorId: "u1",
      actorKind: "user",
      createdAt: "2026-10-27T00:00:00.000Z",
      id: "event-hidden",
      payload: '{"text":"Hidden"}',
      sessionId: "not-artifact-thread",
      type: "message.user",
      workspaceId: "w1",
    },
  ]);
  expect(
    (await h.service.transcript(h.credential)).events.map((event) => event.id)
  ).toEqual(["event-artifact"]);
  expect(
    (await h.service.transcript(h.credential)).events[0]?.actorDisplay
  ).toEqual({ name: "Guest" });
  await h.db
    .update(sessions)
    .set({ private: true })
    .where(eq(sessions.id, "guest-artifact-thread"));
  expect((await h.service.transcript(h.credential)).events).toEqual([]);
});

test("guest invitation list contains only current same-identity live grants", async () => {
  const h = await setup();
  expect(await h.service.invitations(h.credential)).toEqual([
    {
      artifactId: h.credential.artifactId,
      expiresAt: "2026-10-28T00:00:00.000Z",
      role: "commenter",
      title: "Guest",
    },
  ]);
  await h.db
    .update(artifactMembers)
    .set({ revokedAt: "2026-10-27T00:01:00Z" })
    .where(eq(artifactMembers.id, "m1"));
  await expect(h.service.invitations(h.credential)).rejects.toThrow();
});
