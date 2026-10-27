import { expect, test } from "bun:test";
import {
  approvedToolTargets,
  callableConnectors,
  findArtifactAccess,
  findVersionStatus,
} from "./artifact-calls.ts";
import { agents } from "./schema/agents.ts";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
} from "./schema/artifacts.ts";
import { agentConnectors, connectors } from "./schema/connectors.ts";
import { workspaces } from "./schema/workspaces.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const seed = () => {
  const db = migrated();
  for (const id of ["w1", "w2"]) {
    db.insert(workspaces)
      .values({
        clerkOrgId: `org_${id}`,
        createdAt: NOW,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
  db.insert(artifacts)
    .values({
      audience: "workspace",
      createdAt: NOW,
      createdById: "u1",
      createdByKind: "user",
      id: "ar1",
      kind: "app",
      ownerUserId: "u1",
      title: "App",
      updatedAt: NOW,
      workspaceId: "w1",
    })
    .run();
  db.insert(artifactVersions)
    .values({
      artifactId: "ar1",
      authorId: "u1",
      authorKind: "user",
      createdAt: NOW,
      entry: "index.html",
      fileCount: 1,
      id: "v1",
      manifestKey: "w1/artifact-manifests/v1.json",
      message: "m",
      number: 1,
      status: "published",
      totalBytes: 1,
      workspaceId: "w1",
    })
    .run();
  return db;
};

const grant = (
  id: string,
  target: string,
  status: "approved" | "pending" | "rejected",
  kind: "host" | "tool" = "tool"
) => ({
  createdAt: NOW,
  id,
  kind,
  status,
  target,
  versionId: "v1",
  workspaceId: "w1",
});

test("findArtifactAccess is scoped to the workspace and hides deleted artifacts", async () => {
  const db = seed();
  expect(
    await findArtifactAccess(db, { artifactId: "ar1", workspaceId: "w1" })
  ).toEqual({
    agentId: null,
    audience: "workspace",
    handedToAgentId: null,
    ownerUserId: "u1",
  });
  expect(
    await findArtifactAccess(db, { artifactId: "ar1", workspaceId: "w2" })
  ).toBeNull();
  db.update(artifacts).set({ deletedAt: NOW }).run();
  expect(
    await findArtifactAccess(db, { artifactId: "ar1", workspaceId: "w1" })
  ).toBeNull();
});

test("findVersionStatus needs the version to belong to the artifact", async () => {
  const db = seed();
  expect(
    await findVersionStatus(db, {
      artifactId: "ar1",
      versionId: "v1",
      workspaceId: "w1",
    })
  ).toBe("published");
  expect(
    await findVersionStatus(db, {
      artifactId: "other",
      versionId: "v1",
      workspaceId: "w1",
    })
  ).toBeNull();
});

test("approvedToolTargets returns only approved tool grants of the version", async () => {
  const db = seed();
  db.insert(artifactGrants)
    .values([
      grant("g1", "xero/list_invoices", "approved"),
      grant("g2", "xero/create_bill", "pending"),
      grant("g3", "xero/old", "rejected"),
      grant("g4", "api.example.com", "approved", "host"),
    ])
    .run();
  expect(
    await approvedToolTargets(db, { versionId: "v1", workspaceId: "w1" })
  ).toEqual(["xero/list_invoices"]);
  expect(
    await approvedToolTargets(db, { versionId: "v1", workspaceId: "w2" })
  ).toEqual([]);
});

test("callableConnectors lists the workspace's connectors in creation order", async () => {
  const db = seed();
  const row = (id: string, name: string, createdAt: string, ws = "w1") => ({
    authKind: "none" as const,
    createdAt,
    createdBy: "u1",
    id,
    name,
    status: "ok" as const,
    url: `https://${id}.example.com/mcp`,
    workspaceId: ws,
  });
  db.insert(connectors)
    .values([
      row("c2", "Second", "2026-01-02T00:00:00.000Z"),
      row("c1", "First", NOW),
      row("c3", "Elsewhere", NOW, "w2"),
    ])
    .run();
  const rows = await callableConnectors(db, {
    agentId: null,
    workspaceId: "w1",
  });
  expect(rows.map((r) => r.id)).toEqual(["c1", "c2"]);
  expect(rows[0]?.tools).toBe("[]");
});

test("callableConnectors for an agent lists its assigned connectors in assignment order", async () => {
  const db = seed();
  db.insert(agents)
    .values({
      createdAt: NOW,
      createdBy: "u1",
      id: "ag1",
      instructions: "",
      model: "m",
      name: "A",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "a",
      status: "active",
      workspaceId: "w1",
    })
    .run();
  const row = (id: string) => ({
    authKind: "none" as const,
    createdAt: NOW,
    createdBy: "u1",
    id,
    name: "Xero",
    status: "ok" as const,
    url: `https://${id}.example.com/mcp`,
    workspaceId: "w1",
  });
  db.insert(connectors)
    .values([row("c1"), row("c2")])
    .run();
  db.insert(agentConnectors)
    .values({
      agentId: "ag1",
      connectorId: "c2",
      createdAt: NOW,
      workspaceId: "w1",
    })
    .run();
  const rows = await callableConnectors(db, {
    agentId: "ag1",
    workspaceId: "w1",
  });
  expect(rows.map((r) => r.id)).toEqual(["c2"]);
});
