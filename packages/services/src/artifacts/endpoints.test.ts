import { expect, test } from "bun:test";
import { artifactEndpoints, artifactGrants, artifacts, artifactVersions, artifactViews } from "@repo/db/schema/artifacts";
import { eq } from "drizzle-orm";
import { createArtifactEndpointsService } from "./endpoints.ts";
import { harness, principals } from "./test-harness.ts";

const setup = () => {
  const h = harness();
  const now = new Date().toISOString();
  h.db.insert(artifacts).values({ id: "a", workspaceId: "w1", kind: "app", audience: "workspace", createdByKind: "user", createdById: "u1", ownerUserId: "u1", title: "Bot", createdAt: now, updatedAt: now, currentVersionId: "v" }).run();
  h.db.insert(artifactVersions).values({ id: "v", artifactId: "a", workspaceId: "w1", authorKind: "user", authorId: "u1", createdAt: now, entry: "index.html", fileCount: 1, manifestKey: "m", message: "", number: 1, status: "published", totalBytes: 1 }).run();
  const service = createArtifactEndpointsService({ ...h, clock: { now: () => new Date(now) }, publicBaseUrl: "https://agentum.test" });
  const approve = () => h.db.insert(artifactGrants).values({ id: "g", workspaceId: "w1", versionId: "v", kind: "endpoint", target: "discord", status: "approved", createdAt: now }).run();
  return { ...h, service, approve, now };
};

test("endpoint approval provisioning is stable, resolves only the live approved grant", async () => {
  const { db, service, approve } = setup();
  await service.ensure("a", "w1", "discord");
  await service.ensure("a", "w1", "discord");
  const [row] = db.select().from(artifactEndpoints).all();
  expect(row?.id).toMatch(/^[A-Za-z0-9_-]{32}$/);
  expect(db.select().from(artifactEndpoints).all()).toHaveLength(1);
  expect(await service.resolve(row!.id)).toBeNull();
  approve();
  expect(await service.resolve(row!.id)).toMatchObject({ artifactId: "a", versionId: "v", workspaceId: "w1" });
  await db.update(artifactGrants).set({ status: "pending" });
  expect(await service.resolve(row!.id)).toBeNull();
  await db.update(artifactGrants).set({ status: "approved" });
  await db.update(artifacts).set({ currentVersionId: null });
  expect(await service.resolve(row!.id)).toBeNull();
  expect(await service.resolve("unknown")).toBeNull();
});

test("owner/admin can disable, enable and rotate; other members and credentials cannot manage", async () => {
  const { service, approve } = setup();
  approve();
  await service.ensure("a", "w1", "discord");
  const [row] = await service.list(principals.owner, "a");
  expect(row!.url).toBe(`https://agentum.test/hooks/${row!.id}`);
  for (const principal of [principals.stranger, principals.agentOne, principals.keyReader, principals.otherWorkspace]) {
    await expect(service.list(principal, "a")).rejects.toThrow();
    await expect(service.change(principal, row!.id, "rotate")).rejects.toThrow();
  }
  await service.change(principals.owner, row!.id, "disable");
  expect(await service.resolve(row!.id)).toBeNull();
  await service.change(principals.admin, row!.id, "enable");
  expect(await service.resolve(row!.id)).not.toBeNull();
  const next = await service.change(principals.owner, row!.id, "rotate");
  expect(await service.resolve(row!.id)).toBeNull();
  expect(await service.resolve(next.id)).not.toBeNull();
  await expect(service.change(principals.owner, row!.id, "enable")).rejects.toThrow();
});

test("known endpoint calls log privacy metadata and rate limited outcomes", async () => {
  const { db, service } = setup();
  await service.ensure("a", "w1", "discord");
  const [row] = db.select().from(artifactEndpoints).all();
  await service.recordCall(row!.id, { ipPrefix: "1.2.3.0/24", place: null, userAgent: "test", visitorHash: "hash" }, "rate_limited");
  expect(db.select().from(artifactViews).where(eq(artifactViews.artifactId, "a")).get()).toMatchObject({ outcome: "rate_limited", surface: "live_call", visitorHash: "hash", userId: null, shareId: null });
});
