import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { type Composed, composeWith } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ARTIFACT = "0b6f4c2e-8a1d-4f3e-9c2b-7d5e1a2b3c4d";
const NOW = "2026-10-27T00:00:00.000Z";

let db: ReturnType<typeof migrated>;
let composed: Composed;

beforeEach(() => {
  db = migrated();
  const store = new Map<string, string>();
  composed = composeWith({
    allowedOrgIds: ["org_a"],
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: (key) => Promise.resolve(store.get(key) ?? null),
        put: (key, body) => {
          store.set(key, body);
          return Promise.resolve();
        },
      },
      clock: systemClock,
      devFakeRuntime: true,
      fileBlobs: memoryFileBlobs(),
      relay: noopRelay,
    },
  });
});

const session = (userId: string) => ({ orgId: "org_a", userId });

/** A caller plus the workspace id, with an app artifact owned by `owner` seeded. */
const setup = async (owner = "user_1") => {
  const context = await buildContext({ composed, session: session(owner) });
  const { principal } = context;
  if (principal?.kind !== "user") {
    throw new Error("expected a user principal");
  }
  const { workspaceId } = principal;
  await db.insert(artifacts).values({
    audience: "workspace",
    createdAt: NOW,
    createdById: owner,
    createdByKind: "user",
    currentVersionId: "v1",
    id: ARTIFACT,
    kind: "app",
    ownerUserId: owner,
    title: "Intake",
    updatedAt: NOW,
    workspaceId,
  });
  const version = (
    id: string,
    number: number,
    status: "proposed" | "published"
  ) => ({
    artifactId: ARTIFACT,
    authorId: owner,
    authorKind: "user" as const,
    createdAt: NOW,
    entry: "index.html",
    fileCount: 1,
    id,
    manifestKey: `${workspaceId}/artifact-manifests/${id}.json`,
    message: "m",
    number,
    status,
    totalBytes: 1,
    workspaceId,
  });
  await db
    .insert(artifactVersions)
    .values([version("v1", 1, "published"), version("v2", 2, "proposed")]);
  return { caller: appRouter.createCaller(context), principal, workspaceId };
};

test("pins lists the caller's pins, optionally by surface", async () => {
  const { caller } = await setup();
  await caller.artifacts.pin({ artifactId: ARTIFACT, surface: "sidebar" });
  await caller.artifacts.pin({ artifactId: ARTIFACT, surface: "desk" });
  const all = await caller.artifacts.pins({});
  expect(all.map((pin) => pin.surface).sort()).toEqual(["desk", "sidebar"]);
  const desk = await caller.artifacts.pins({ surface: "desk" });
  expect(desk).toHaveLength(1);
  expect(desk[0]).toMatchObject({ artifactId: ARTIFACT, title: "Intake" });
});

test("grants lists the grants of a version", async () => {
  const { caller, workspaceId } = await setup();
  await db.insert(artifactGrants).values({
    createdAt: NOW,
    id: "g1",
    kind: "tool",
    status: "pending",
    target: "github/list_issues",
    versionId: "v2",
    workspaceId,
  });
  const rows = await caller.artifacts.grants({
    artifactId: ARTIFACT,
    versionId: "v2",
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: "g1",
    status: "pending",
    target: "github/list_issues",
  });
});
