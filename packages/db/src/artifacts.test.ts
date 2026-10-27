import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  artifactPins,
  artifactShares,
  artifacts,
  artifactVersions,
} from "./schema/artifacts.ts";
import { events } from "./schema/events.ts";
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
  db.insert(artifacts)
    .values({
      audience: "workspace",
      createdAt: NOW,
      createdById: "u1",
      createdByKind: "user",
      id: "ar1",
      kind: "page",
      title: "Report",
      updatedAt: NOW,
      workspaceId: "w1",
    })
    .run();
  return db;
};

const version = (id: string, number: number) => ({
  artifactId: "ar1",
  authorId: "u1",
  authorKind: "user" as const,
  createdAt: NOW,
  entry: "index.html",
  fileCount: 1,
  id,
  manifestKey: `w1/artifact-manifests/${id}.json`,
  message: "m",
  number,
  status: "published" as const,
  totalBytes: 1,
  workspaceId: "w1",
});

const share = (id: string, tokenHash: string) => ({
  artifactId: "ar1",
  createdAt: NOW,
  createdBy: "u1",
  id,
  kind: "link" as const,
  tokenEncrypted: "enc",
  tokenHash,
  workspaceId: "w1",
});

const pin = (id: string, surface: "sidebar" | "desk") => ({
  artifactId: "ar1",
  createdAt: NOW,
  id,
  position: 0,
  surface,
  userId: "u1",
  workspaceId: "w1",
});

test("a version number is unique per artifact, a different number works", () => {
  const db = seed();
  db.insert(artifactVersions).values(version("av1", 1)).run();
  expect(() =>
    db.insert(artifactVersions).values(version("av2", 1)).run()
  ).toThrow("UNIQUE constraint failed");
  db.insert(artifactVersions).values(version("av2", 2)).run();
  expect(db.select().from(artifactVersions).all()).toHaveLength(2);
});

test("a share token hash is unique", () => {
  const db = seed();
  db.insert(artifactShares).values(share("sh1", "h")).run();
  expect(() =>
    db.insert(artifactShares).values(share("sh2", "h")).run()
  ).toThrow("UNIQUE constraint failed");
  db.insert(artifactShares).values(share("sh2", "h2")).run();
  expect(db.select().from(artifactShares).all()).toHaveLength(2);
});

test("a pin is unique per user, artifact and surface", () => {
  const db = seed();
  db.insert(artifactPins).values(pin("p1", "sidebar")).run();
  expect(() =>
    db.insert(artifactPins).values(pin("p2", "sidebar")).run()
  ).toThrow("UNIQUE constraint failed");
  db.insert(artifactPins).values(pin("p2", "desk")).run();
  expect(db.select().from(artifactPins).all()).toHaveLength(2);
});

test("handed_to_agent_id rejects an unknown agent", () => {
  const db = seed();
  expect(() =>
    db
      .update(artifacts)
      .set({ handedToAgentId: "nope" })
      .where(eq(artifacts.id, "ar1"))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
});

test("the events triggers still refuse UPDATE and DELETE after the artifacts migration", () => {
  const db = seed();
  db.insert(events)
    .values({
      actorId: "u1",
      actorKind: "user",
      createdAt: NOW,
      id: "e1",
      type: "run.queued",
      workspaceId: "w1",
    })
    .run();
  expect(() =>
    db
      .update(events)
      .set({ type: "run.failed" })
      .where(eq(events.id, "e1"))
      .run()
  ).toThrow("events is append-only");
  expect(() => db.delete(events).run()).toThrow("events is append-only");
  expect(db.select().from(events).all()).toHaveLength(1);
});
