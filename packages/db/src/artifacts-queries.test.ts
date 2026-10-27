import { expect, test } from "bun:test";
import {
  activeLinkCounts,
  knownBlobSizes,
  listArtifacts,
  workspaceBlobBytes,
} from "./artifacts.ts";
import {
  artifactShares,
  artifacts,
  artifactVersionFiles,
  artifactVersions,
} from "./schema/artifacts.ts";
import { workspaces } from "./schema/workspaces.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-10-27T00:00:00.000Z";
const LATER = "2026-10-28T00:00:00.000Z";
const EARLIER = "2026-10-26T00:00:00.000Z";

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
  return db;
};

const artifact = (
  id: string,
  over: Partial<typeof artifacts.$inferInsert>
) => ({
  audience: "workspace" as const,
  createdAt: NOW,
  createdById: "u1",
  createdByKind: "user" as const,
  id,
  kind: "page" as const,
  ownerUserId: "u1",
  title: id,
  updatedAt: NOW,
  workspaceId: "w1",
  ...over,
});

const filter = {
  limit: 10,
  now: NOW,
  visibility: { kind: "admin" } as const,
};

test("visibility, soft delete and keyset paging", async () => {
  const db = seed();
  db.insert(artifacts)
    .values([
      artifact("a", { updatedAt: "2026-10-27T00:00:03.000Z" }),
      artifact("b", {
        audience: "private",
        ownerUserId: "u2",
        updatedAt: "2026-10-27T00:00:02.000Z",
      }),
      artifact("c", { deletedAt: NOW, updatedAt: "2026-10-27T00:00:01.000Z" }),
      artifact("d", { updatedAt: "2026-10-27T00:00:00.000Z" }),
    ])
    .run();
  const ids = async (
    visibility: typeof filter.visibility | { kind: "member"; userId: string }
  ) =>
    (await listArtifacts(db, "w1", { ...filter, visibility })).map((r) => r.id);
  expect(await ids({ kind: "admin" })).toEqual(["a", "b", "d"]);
  expect(await ids({ kind: "member", userId: "u1" })).toEqual(["a", "d"]);
  expect(await ids({ kind: "member", userId: "u2" })).toEqual(["a", "b", "d"]);
  const page = await listArtifacts(db, "w1", { ...filter, limit: 1 });
  expect(page.map((r) => r.id)).toEqual(["a", "b"]);
  const next = await listArtifacts(db, "w1", {
    ...filter,
    after: { id: "a", updatedAt: "2026-10-27T00:00:03.000Z" },
    limit: 1,
  });
  expect(next.map((r) => r.id)).toEqual(["b", "d"]);
});

test("active links ignore revoked and expired ones", async () => {
  const db = seed();
  db.insert(artifacts)
    .values([artifact("a", {}), artifact("b", {})])
    .run();
  const share = (
    id: string,
    artifactId: string,
    over: Partial<typeof artifactShares.$inferInsert>
  ) => ({
    artifactId,
    createdAt: NOW,
    createdBy: "u1",
    id,
    kind: "link" as const,
    tokenEncrypted: "x",
    tokenHash: id,
    workspaceId: "w1",
    ...over,
  });
  db.insert(artifactShares)
    .values([
      share("s1", "a", {}),
      share("s2", "a", { expiresAt: LATER }),
      share("s3", "a", { revokedAt: NOW }),
      share("s4", "a", { expiresAt: EARLIER }),
    ])
    .run();
  expect((await activeLinkCounts(db, "w1", ["a", "b"], NOW)).get("a")).toBe(2);
  const only = (shared: boolean) =>
    listArtifacts(db, "w1", { ...filter, shared }).then((r) =>
      r.map((x) => x.id)
    );
  expect(await only(true)).toEqual(["a"]);
  expect(await only(false)).toEqual(["b"]);
});

test("blob bytes count each distinct hash once", async () => {
  const db = seed();
  db.insert(artifacts).values(artifact("a", {})).run();
  const version = (id: string, number: number) => ({
    artifactId: "a",
    authorId: "u1",
    authorKind: "user" as const,
    createdAt: NOW,
    entry: "index.html",
    fileCount: 1,
    id,
    manifestKey: `w1/artifact-manifests/${id}.json`,
    message: "",
    number,
    status: "published" as const,
    totalBytes: 1,
    workspaceId: "w1",
  });
  db.insert(artifactVersions)
    .values([version("v1", 1), version("v2", 2)])
    .run();
  const file = (
    versionId: string,
    path: string,
    sha256: string,
    size: number
  ) => ({
    contentType: "text/html",
    path,
    sha256,
    size,
    versionId,
    workspaceId: "w1",
  });
  db.insert(artifactVersionFiles)
    .values([
      file("v1", "index.html", "h1", 100),
      file("v1", "a.css", "h2", 50),
      file("v2", "index.html", "h1", 100),
    ])
    .run();
  expect(await workspaceBlobBytes(db, "w1")).toBe(150);
  expect(await workspaceBlobBytes(db, "other")).toBe(0);
  expect([...(await knownBlobSizes(db, "w1", ["h1", "h3"]))]).toEqual([
    ["h1", 100],
  ]);
});
