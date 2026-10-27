/** biome-ignore-all lint/performance/noAwaitInLoops: Ordered authorization mutations are restored between assertions. */
import { expect, test } from "bun:test";
import {
  artifacts,
  artifactVersionFiles,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import {
  artifactMembers,
  guestIdentities,
  guestSessions,
} from "@repo/db/schema/live-artifacts";
import { workspaces } from "@repo/db/schema/workspaces";
import { eq } from "drizzle-orm";
import { harness, principals } from "../artifacts/test-harness.ts";
import { createGuestEmbeds } from "./embeds.ts";
import { newGuestSessionToken } from "./security.ts";

const setup = async () => {
  const h = harness();
  const at = "2026-10-27T00:00:00.000Z";
  const expiresAt = "2026-10-28T00:00:00.000Z";
  const deckId = crypto.randomUUID();
  await h.db.insert(artifacts).values({
    audience: "private",
    createdAt: at,
    createdById: "u1",
    createdByKind: "user",
    id: deckId,
    kind: "deck",
    ownerUserId: "u1",
    title: "Invited deck",
    updatedAt: at,
    workspaceId: "w1",
  });
  const page = await h.service.create(principals.owner, {
    entry: "chart.html",
    files: [{ path: "chart.html", text: "<h1>Chart</h1>" }],
    kind: "page",
    title: "Source",
  });
  await h.service.setAudience(principals.owner, page.artifactId, "workspace");
  const [file] = await h.db
    .select()
    .from(artifactVersionFiles)
    .where(eq(artifactVersionFiles.versionId, page.versionId));
  if (!file) {
    throw new Error("Missing source");
  }
  const source = `artifact:${page.artifactId}:${page.versionId}:${file.sha256}:chart.html`;
  await h.db.insert(guestIdentities).values({
    createdAt: at,
    displayName: "Guest",
    email: "guest@example.com",
    id: "g1",
    workspaceId: "w1",
  });
  await h.db.insert(artifactMembers).values({
    artifactId: deckId,
    createdAt: at,
    createdBy: "u1",
    expiresAt,
    guestId: "g1",
    id: "m1",
    principalKind: "guest",
    role: "viewer",
    workspaceId: "w1",
  });
  const token = await newGuestSessionToken();
  await h.db.insert(guestSessions).values({
    createdAt: at,
    expiresAt,
    guestId: "g1",
    id: "gs1",
    lastUsedAt: at,
    tokenHash: token.hash,
    workspaceId: "w1",
  });
  let retained = [source];
  let off = false;
  const service = createGuestEmbeds({
    ...h,
    clock: { now: () => new Date(at), sleep: () => Promise.resolve() },
    guestsOff: () => off,
    retained: async (scope) => {
      await Promise.resolve();
      if (scope.artifactId !== deckId) {
        throw new Error("Wrong deck scope");
      }
      return retained;
    },
  });
  return {
    ...h,
    credential: {
      artifactId: deckId,
      sessionToken: token.token,
      workspaceId: "w1",
    },
    off: () => {
      off = true;
    },
    page,
    remove: () => {
      retained = [];
    },
    service,
    source,
  };
};
test("guest source authority is current, exact, retained and scoped to the invited deck", async () => {
  const h = await setup();
  const claims = await h.service.resolve(h.credential, h.source);
  expect(claims.userId).toBeUndefined();
  expect(claims.guestEmbed?.memberId).toBe("m1");
  expect(await h.service.authorize(claims)).toBe(true);
  for (const source of [
    h.source.replace("chart.html", "other.html"),
    h.source.replace(h.page.versionId, crypto.randomUUID()),
    h.source.replace(h.page.artifactId, crypto.randomUUID()),
  ]) {
    await expect(h.service.resolve(h.credential, source)).rejects.toThrow();
  }
  await expect(
    h.service.resolve(
      { ...h.credential, artifactId: h.page.artifactId },
      h.source
    )
  ).rejects.toThrow();
  await expect(
    h.service.resolve({ ...h.credential, workspaceId: "w2" }, h.source)
  ).rejects.toThrow();
  for (const change of [
    { audience: "private" as const },
    { kind: "app" as const },
    { deletedAt: "2026-10-27T00:00:00.000Z" },
  ]) {
    await h.db
      .update(artifacts)
      .set(change)
      .where(eq(artifacts.id, h.page.artifactId));
    expect(await h.service.authorize(claims)).toBe(false);
    await h.db
      .update(artifacts)
      .set({ audience: "workspace", deletedAt: null, kind: "page" })
      .where(eq(artifacts.id, h.page.artifactId));
  }
  await h.db
    .update(artifactVersions)
    .set({ status: "proposed" })
    .where(eq(artifactVersions.id, h.page.versionId));
  expect(await h.service.authorize(claims)).toBe(false);
  await h.db
    .update(artifactVersions)
    .set({ status: "published" })
    .where(eq(artifactVersions.id, h.page.versionId));
  h.remove();
  expect(await h.service.authorize(claims)).toBe(false);
});
test("issued capabilities recheck grant, session, workspace switch and emergency disable", async () => {
  const h = await setup();
  const claims = await h.service.resolve(h.credential, h.source);
  await h.db
    .update(artifactMembers)
    .set({ revokedAt: "2026-10-27T00:00:00.000Z" })
    .where(eq(artifactMembers.id, "m1"));
  expect(await h.service.authorize(claims)).toBe(false);
  await h.db
    .update(artifactMembers)
    .set({ revokedAt: null })
    .where(eq(artifactMembers.id, "m1"));
  await h.db
    .update(workspaces)
    .set({ liveGuestsEnabled: false })
    .where(eq(workspaces.id, "w1"));
  expect(await h.service.authorize(claims)).toBe(false);
  await h.db
    .update(workspaces)
    .set({ liveGuestsEnabled: true })
    .where(eq(workspaces.id, "w1"));
  await h.db.delete(guestSessions).where(eq(guestSessions.id, "gs1"));
  expect(await h.service.authorize(claims)).toBe(false);
  h.off();
  await expect(h.service.resolve(h.credential, h.source)).rejects.toThrow();
});
