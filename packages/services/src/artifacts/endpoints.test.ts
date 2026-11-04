import { expect, test } from "bun:test";
import {
  artifactEndpoints,
  artifactGrants,
  artifacts,
  artifactVersions,
  artifactViews,
} from "@repo/db/schema/artifacts";
import { eq } from "drizzle-orm";
import { createArtifactEndpointsService } from "./endpoints.ts";
import { harness, principals } from "./test-harness.ts";

const setup = () => {
  const h = harness();
  const now = new Date().toISOString();
  h.db
    .insert(artifacts)
    .values({
      audience: "workspace",
      createdAt: now,
      createdById: "u1",
      createdByKind: "user",
      currentVersionId: "v",
      id: "a",
      kind: "app",
      ownerUserId: "u1",
      title: "Bot",
      updatedAt: now,
      workspaceId: "w1",
    })
    .run();
  h.db
    .insert(artifactVersions)
    .values({
      artifactId: "a",
      authorId: "u1",
      authorKind: "user",
      createdAt: now,
      entry: "index.html",
      fileCount: 1,
      id: "v",
      manifestKey: "m",
      message: "",
      number: 1,
      status: "published",
      totalBytes: 1,
      workspaceId: "w1",
    })
    .run();
  const service = createArtifactEndpointsService({
    ...h,
    clock: { now: () => new Date(now) },
    publicBaseUrl: "https://agentum.test",
  });
  const approve = () =>
    h.db
      .insert(artifactGrants)
      .values({
        createdAt: now,
        id: "g",
        kind: "endpoint",
        status: "approved",
        target: "discord",
        versionId: "v",
        workspaceId: "w1",
      })
      .run();
  const seed = () =>
    h.atomic([
      h.db
        .insert(artifactEndpoints)
        .values({
          artifactId: "a",
          createdAt: now,
          id: "01234567890123456789012345678901",
          name: "discord",
          workspaceId: "w1",
        })
        .onConflictDoNothing(),
    ]);
  return { ...h, approve, now, seed, service };
};

test("endpoint resolves only the live approved grant", async () => {
  const { db, service, approve, seed } = setup();
  await seed();
  const [row] = db.select().from(artifactEndpoints).all();
  if (!row) {
    throw new Error("Missing endpoint");
  }
  expect(db.select().from(artifactEndpoints).all()).toHaveLength(1);
  expect(await service.resolve(row.id)).toBeNull();
  approve();
  expect(await service.resolve(row.id)).toMatchObject({
    artifactId: "a",
    versionId: "v",
    workspaceId: "w1",
  });
  await db.update(artifactGrants).set({ status: "pending" });
  expect(await service.resolve(row.id)).toBeNull();
  await db.update(artifactGrants).set({ status: "approved" });
  await db.update(artifacts).set({ currentVersionId: null });
  expect(await service.resolve(row.id)).toBeNull();
  expect(await service.resolve("unknown")).toBeNull();
});

test("owner/admin can disable, enable and rotate; other members and credentials cannot manage", async () => {
  const { service, approve, seed } = setup();
  approve();
  await seed();
  const [row] = await service.list(principals.owner, "a");
  if (!row) {
    throw new Error("Missing endpoint");
  }
  expect(row.url).toBe(`https://agentum.test/hooks/${row.id}`);
  await Promise.all(
    [
      principals.stranger,
      principals.agentOne,
      principals.keyReader,
      principals.otherWorkspace,
    ].map(async (principal) => {
      await expect(service.list(principal, "a")).rejects.toThrow();
      await expect(
        service.change(principal, row.id, "rotate")
      ).rejects.toThrow();
    })
  );
  await service.change(principals.owner, row.id, "disable");
  expect(await service.resolve(row.id)).toBeNull();
  await service.change(principals.admin, row.id, "enable");
  expect(await service.resolve(row.id)).not.toBeNull();
  const next = await service.change(principals.owner, row.id, "rotate");
  expect(await service.resolve(row.id)).toBeNull();
  expect(await service.resolve(next.id)).not.toBeNull();
  expect(await service.list(principals.owner, "a")).toEqual([next]);
  await expect(
    service.change(principals.owner, row.id, "enable")
  ).rejects.toThrow();
});

test("known endpoint calls log privacy metadata and rate limited outcomes", async () => {
  const { db, service, approve, seed } = setup();
  approve();
  await seed();
  const [row] = db.select().from(artifactEndpoints).all();
  if (!row) {
    throw new Error("Missing endpoint");
  }
  await db.update(artifacts).set({ currentVersionId: null });
  await service.recordCall(
    {
      artifactId: "a",
      endpointId: row.id,
      name: "discord",
      versionId: "v",
      workspaceId: "w1",
    },
    {
      ipPrefix: "1.2.3.0/24",
      place: "AU",
      userAgent: "test",
      visitorHash: "hash",
    },
    "rate_limited"
  );
  expect(
    db
      .select()
      .from(artifactViews)
      .where(eq(artifactViews.artifactId, "a"))
      .get()
  ).toMatchObject({
    country: "AU",
    outcome: "rate_limited",
    shareId: null,
    surface: "live_call",
    toolKey: "endpoint:discord",
    userId: null,
    versionId: "v",
    visitorHash: "hash",
  });
});
