import { expect, test } from "bun:test";
import {
  approvedGrantTargets,
  hasGrantOfKind,
  versionWorkspaceId,
} from "./artifact-app.ts";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
} from "./schema/artifacts.ts";
import { workspaces } from "./schema/workspaces.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const seed = () => {
  const db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: NOW,
      id: "w1",
      name: "w1",
      timezone: "UTC",
    })
    .run();
  for (const id of ["ar1", "ar2"]) {
    db.insert(artifacts)
      .values({
        audience: "workspace",
        createdAt: NOW,
        createdById: "u1",
        createdByKind: "user",
        id,
        kind: "app",
        ownerUserId: "u1",
        title: "App",
        updatedAt: NOW,
        workspaceId: "w1",
      })
      .run();
  }
  for (const id of ["v1", "v2"]) {
    db.insert(artifactVersions)
      .values({
        artifactId: "ar1",
        authorId: "u1",
        authorKind: "user",
        createdAt: NOW,
        entry: "index.html",
        fileCount: 1,
        id,
        manifestKey: `w1/artifact-manifests/${id}.json`,
        message: "m",
        number: id === "v1" ? 1 : 2,
        status: "published",
        totalBytes: 1,
        workspaceId: "w1",
      })
      .run();
  }
  return db;
};

const grant = (
  id: string,
  kind: "host" | "secret" | "tool",
  target: string,
  status: "approved" | "pending" | "rejected",
  versionId = "v1"
) => ({
  createdAt: NOW,
  id,
  kind,
  status,
  target,
  versionId,
  workspaceId: "w1",
});

test("approvedGrantTargets returns the approved targets of one kind and version", async () => {
  const db = seed();
  db.insert(artifactGrants)
    .values([
      grant("g1", "host", "b.example.com", "approved"),
      grant("g2", "host", "a.example.com", "approved"),
      grant("g3", "host", "c.example.com", "pending"),
      grant("g4", "host", "d.example.com", "rejected"),
      grant("g5", "secret", "API_KEY", "approved"),
      grant("g6", "host", "other.example.com", "approved", "v2"),
    ])
    .run();
  expect(
    await approvedGrantTargets(db, { kind: "host", versionId: "v1" })
  ).toEqual(["a.example.com", "b.example.com"]);
  expect(
    await approvedGrantTargets(db, { kind: "secret", versionId: "v1" })
  ).toEqual(["API_KEY"]);
  expect(
    await approvedGrantTargets(db, { kind: "tool", versionId: "v1" })
  ).toEqual([]);
});

test("hasGrantOfKind counts a grant of any status", async () => {
  const db = seed();
  db.insert(artifactGrants)
    .values([
      grant("g1", "host", "a.example.com", "rejected"),
      grant("g2", "secret", "API_KEY", "pending", "v2"),
    ])
    .run();
  expect(await hasGrantOfKind(db, { kind: "host", versionId: "v1" })).toBe(
    true
  );
  expect(await hasGrantOfKind(db, { kind: "secret", versionId: "v1" })).toBe(
    false
  );
  expect(await hasGrantOfKind(db, { kind: "secret", versionId: "v2" })).toBe(
    true
  );
});

test("versionWorkspaceId needs the version to belong to the artifact", async () => {
  const db = seed();
  expect(
    await versionWorkspaceId(db, { artifactId: "ar1", versionId: "v1" })
  ).toBe("w1");
  expect(
    await versionWorkspaceId(db, { artifactId: "ar2", versionId: "v1" })
  ).toBeNull();
  expect(
    await versionWorkspaceId(db, { artifactId: "ar1", versionId: "nope" })
  ).toBeNull();
});
