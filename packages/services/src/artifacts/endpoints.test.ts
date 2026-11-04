import { expect, test } from "bun:test";
import {
  artifactEndpoints,
  artifactGrants,
  artifacts,
  artifactVersions,
  artifactViews,
} from "@repo/db/schema/artifacts";
import {
  artifactsAppErrorsOutputSchema,
  artifactsCallsOutputSchema,
} from "@repo/protocol/artifacts";
import { eq } from "drizzle-orm";
import { createArtifactEndpointsService } from "./endpoints.ts";
import { createArtifactErrorsService } from "./errors.ts";
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
      id: "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001",
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
      artifactId: "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001",
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
  const errors = createArtifactErrorsService({ ...h });
  const service = createArtifactEndpointsService({
    errors,
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
          artifactId: "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001",
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
    artifactId: "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001",
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
  const [row] = await service.list(
    principals.owner,
    "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001"
  );
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
      await expect(
        service.list(principal, "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001")
      ).rejects.toThrow();
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
  expect(
    await service.list(principals.owner, "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001")
  ).toEqual([next]);
  await expect(
    service.change(principals.owner, row.id, "enable")
  ).rejects.toThrow();
});

test("known endpoint calls log privacy metadata, status and duration", async () => {
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
      artifactId: "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001",
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
    "error",
    { durationMs: 37, statusCode: 502 }
  );
  expect(
    db
      .select()
      .from(artifactViews)
      .where(
        eq(artifactViews.artifactId, "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001")
      )
      .get()
  ).toMatchObject({
    country: "AU",
    durationMs: 37,
    outcome: "error",
    shareId: null,
    statusCode: 502,
    surface: "live_call",
    toolKey: "endpoint:discord",
    userId: null,
    versionId: "v",
    visitorHash: "hash",
  });
});

test("calls pages only endpoint rows, newest first, with strict private output", async () => {
  const { db, service, now } = setup();
  const artifactId = "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001";
  for (let i = 0; i < 52; i += 1) {
    db.insert(artifactViews)
      .values({
        artifactId,
        country: "AU",
        createdAt: now,
        durationMs: 12,
        id: `call_${String(i).padStart(3, "0")}`,
        ipPrefix: "1.2.3.0/24",
        outcome: "ok",
        statusCode: 204,
        surface: "live_call",
        toolKey: "endpoint:discord",
        versionId: "v",
        visitorHash: "secret",
        workspaceId: "w1",
      })
      .run();
  }
  for (const [id, surface, toolKey] of [
    ["z_open", "viewer", null],
    ["z_tool", "live_call", "tool:read"],
    ["z_wrong_surface", "viewer", "endpoint:discord"],
  ] as const) {
    db.insert(artifactViews)
      .values({
        artifactId,
        createdAt: now,
        id,
        outcome: "ok",
        surface,
        toolKey,
        workspaceId: "w1",
      })
      .run();
  }
  const page = await service.calls(principals.owner, { artifactId });
  expect(artifactsCallsOutputSchema.parse(page)).toEqual(page);
  expect(page.items).toHaveLength(50);
  expect(page.items[0]).toEqual({
    durationMs: 12,
    endpoint: "discord",
    id: "call_051",
    outcome: "ok",
    place: "AU",
    statusCode: 204,
    time: now,
    version: 1,
  });
  expect(page.next).toBe("call_002");
  const last = await service.calls(principals.admin, {
    artifactId,
    cursor: page.next,
  });
  expect(last.items.map((row) => row.id)).toEqual(["call_001", "call_000"]);
  expect(last.next).toBeUndefined();
});

test("diagnostics require an app manager on a browser session", async () => {
  const { db, service } = setup();
  const input = { artifactId: "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001" };
  await Promise.all(
    [
      principals.stranger,
      principals.keyReader,
      principals.agentOne,
      principals.otherWorkspace,
    ].map(async (principal) => {
      await expect(service.calls(principal, input)).rejects.toThrow();
      await expect(service.appErrors(principal, input)).rejects.toThrow();
    })
  );
  expect(
    artifactsAppErrorsOutputSchema.parse(
      await service.appErrors(principals.owner, input)
    )
  ).toEqual([]);
  await db.update(artifacts).set({ kind: "page" });
  await expect(service.calls(principals.owner, input)).rejects.toThrow();
  await expect(service.appErrors(principals.owner, input)).rejects.toThrow();
});

test("appErrors exposes the last ten app.error events through the strict output schema", async () => {
  const { events, service } = setup();
  const artifactId = "7f1d6f0e-3c43-4a4e-9f6b-2b6a1a1c0001";
  await Promise.all(
    Array.from({ length: 12 }, () =>
      events.append({
        actor: { id: "system", kind: "system" },
        payload: {
          artifactId,
          dropped: 3,
          entry: "server.ts",
          message: "connection failed",
          versionId: "v",
        },
        type: "app.error",
        workspaceId: "w1",
      })
    )
  );
  const rows = await service.appErrors(principals.admin, { artifactId });
  expect(artifactsAppErrorsOutputSchema.parse(rows)).toEqual(rows);
  expect(rows).toHaveLength(10);
  expect(rows[0]).toMatchObject({
    dropped: 3,
    entry: "server.ts",
    message: "connection failed",
    version: 1,
    versionId: "v",
  });
});
