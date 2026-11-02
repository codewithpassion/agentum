import { expect, test } from "bun:test";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import type { ProxyMatch } from "../secrets.ts";
import { createAppGrantsService } from "./app-grants.ts";

const NOW = "2026-10-27T00:00:00.000Z";

const MATCH: ProxyMatch = {
  header: "Authorization",
  headerValue: "Bearer s3cret-value",
  name: "API_KEY",
  value: "s3cret-value",
};

const setup = (
  member: (userId: string, orgId: string) => Promise<boolean> = () =>
    Promise.resolve(true)
) => {
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
  for (const [id, number] of [
    ["v1", 1],
    ["v2", 2],
  ] as const) {
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
        number,
        status: "published",
        totalBytes: 1,
        workspaceId: "w1",
      })
      .run();
  }
  const calls: { host: string; names: readonly string[]; ws: string }[] = [];
  const service = createAppGrantsService({
    db,
    isOrgMember: member,
    secrets: {
      proxyForNames: (ws, names, host) => {
        calls.push({ host, names, ws });
        return Promise.resolve([MATCH]);
      },
    },
  });
  const grant = (
    id: string,
    kind: "host" | "secret",
    target: string,
    status: "approved" | "pending" | "rejected",
    versionId = "v1"
  ) =>
    db
      .insert(artifactGrants)
      .values({
        createdAt: NOW,
        id,
        kind,
        status,
        target,
        versionId,
        workspaceId: "w1",
      })
      .run();
  return { calls, grant, service };
};

test("approvedHosts lists only the approved hosts of the version", async () => {
  const { grant, service } = setup();
  grant("g1", "host", "api.example.com", "approved");
  grant("g2", "host", "pending.example.com", "pending");
  grant("g3", "host", "no.example.com", "rejected");
  grant("g4", "secret", "API_KEY", "approved");
  grant("g5", "host", "other.example.com", "approved", "v2");
  expect(await service.approvedHosts("v1")).toEqual(["api.example.com"]);
});

test("declaresHosts is true for a host grant of any status", async () => {
  const { grant, service } = setup();
  expect(await service.declaresHosts("v1")).toBe(false);
  grant("g1", "secret", "API_KEY", "approved");
  expect(await service.declaresHosts("v1")).toBe(false);
  grant("g2", "host", "api.example.com", "rejected");
  expect(await service.declaresHosts("v1")).toBe(true);
  expect(await service.declaresHosts("v2")).toBe(false);
});

test("secretRules asks secrets for the approved names only", async () => {
  const { calls, grant, service } = setup();
  grant("g1", "secret", "API_KEY", "approved");
  grant("g2", "secret", "PENDING_KEY", "pending");
  grant("g3", "secret", "OLD_KEY", "rejected");
  grant("g4", "host", "api.example.com", "approved");
  expect(await service.secretRules("w1", "v1", "api.example.com")).toEqual([
    MATCH,
  ]);
  expect(calls).toEqual([
    { host: "api.example.com", names: ["API_KEY"], ws: "w1" },
  ]);
});

test("secretRules returns [] without calling secrets when no secret is approved", async () => {
  const { calls, grant, service } = setup();
  grant("g1", "secret", "PENDING_KEY", "pending");
  expect(await service.secretRules("w1", "v1", "api.example.com")).toEqual([]);
  expect(calls).toEqual([]);
});

test("versionWorkspaceId needs the version to belong to the artifact", async () => {
  const { service } = setup();
  expect(await service.versionWorkspaceId("ar1", "v1")).toBe("w1");
  expect(await service.versionWorkspaceId("other", "v1")).toBeNull();
});

test("memberPrincipal asks Clerk again and builds a session principal", async () => {
  const asked: string[] = [];
  const { service } = setup((userId, orgId) => {
    asked.push(`${userId}@${orgId}`);
    return Promise.resolve(userId === "u1");
  });
  expect(await service.memberPrincipal("u1", "w1")).toEqual({
    kind: "user",
    userId: "u1",
    via: "session",
    workspaceId: "w1",
  });
  expect(await service.memberPrincipal("u2", "w1")).toBeNull();
  expect(await service.memberPrincipal("u1", "nope")).toBeNull();
  expect(asked).toEqual(["u1@org_w1", "u2@org_w1"]);
});

test("memberPrincipal refuses without a membership check", async () => {
  const { db } = { db: migrated() };
  const service = createAppGrantsService({
    db,
    secrets: { proxyForNames: () => Promise.resolve([]) },
  });
  expect(await service.memberPrincipal("u1", "w1")).toBeNull();
});
