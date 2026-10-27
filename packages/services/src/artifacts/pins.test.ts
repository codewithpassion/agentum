import { expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { artifactPins, artifacts } from "@repo/db/schema/artifacts";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import { createArtifactPinsService } from "./pins.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const ID = {
  pa: "33333333-3333-4333-8333-333333333333",
  pb: "44444444-4444-4444-8444-444444444444",
  w2a: "55555555-5555-4555-8555-555555555555",
  wa: "11111111-1111-4111-8111-111111111111",
  wb: "22222222-2222-4222-8222-222222222222",
} as const;

const user = (
  userId: string,
  workspaceId = "w1",
  isAdmin = false
): Principal => ({
  isAdmin,
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});

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
  const artifact = (
    id: string,
    overrides: Partial<typeof artifacts.$inferInsert> = {}
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
    ...overrides,
  });
  db.insert(artifacts)
    .values([
      artifact(ID.wa),
      artifact(ID.wb),
      artifact(ID.pa, { audience: "private" }),
    ])
    .run();
  db.insert(artifacts)
    .values(artifact(ID.pb, { audience: "private", ownerUserId: "u2" }))
    .run();
  db.insert(artifacts)
    .values(artifact(ID.w2a, { workspaceId: "w2" }))
    .run();
  return db;
};

const setup = () => {
  const db = seed();
  const clock = { now: () => new Date(NOW), sleep: () => Promise.resolve() };
  const pins = createArtifactPinsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
  });
  return { db, pins };
};

const pinRows = (db: ReturnType<typeof seed>) =>
  db.select().from(artifactPins).all();

const rejectionOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
};

test("sidebar and desk pins are independent", async () => {
  const { pins } = setup();
  const u1 = user("u1");
  await pins.pin(u1, { artifactId: ID.wa, surface: "sidebar" });
  await pins.pin(u1, { artifactId: ID.wa, surface: "desk" });

  const rows = await pins.list(u1);
  expect(rows.map((row) => row.surface).sort()).toEqual(["desk", "sidebar"]);

  await pins.unpin(u1, { artifactId: ID.wa, surface: "desk" });
  expect((await pins.list(u1)).map((row) => row.surface)).toEqual(["sidebar"]);
  expect(await pins.list(u1, { surface: "desk" })).toEqual([]);
});

test("positions count up per surface", async () => {
  const { pins } = setup();
  const u1 = user("u1");
  await pins.pin(u1, { artifactId: ID.wa, surface: "sidebar" });
  await pins.pin(u1, { artifactId: ID.wb, surface: "sidebar" });
  await pins.pin(u1, { artifactId: ID.wa, surface: "desk" });

  const rows = await pins.list(u1);
  const position = (artifactId: string, surface: string) =>
    rows.find((row) => row.artifactId === artifactId && row.surface === surface)
      ?.position;
  expect(position(ID.wa, "sidebar")).toBe(1);
  expect(position(ID.wb, "sidebar")).toBe(2);
  expect(position(ID.wa, "desk")).toBe(1);
});

test("pinning twice leaves one row", async () => {
  const { db, pins } = setup();
  const u1 = user("u1");
  await pins.pin(u1, { artifactId: ID.wa, surface: "sidebar" });
  await pins.pin(u1, { artifactId: ID.wa, surface: "sidebar" });

  expect(pinRows(db)).toHaveLength(1);
  expect(await pins.list(u1)).toHaveLength(1);
});

test("unpin removes the pin, and a second unpin is fine", async () => {
  const { db, pins } = setup();
  const u1 = user("u1");
  await pins.pin(u1, { artifactId: ID.wa, surface: "sidebar" });
  await pins.unpin(u1, { artifactId: ID.wa, surface: "sidebar" });
  await pins.unpin(u1, { artifactId: ID.wa, surface: "sidebar" });

  expect(pinRows(db)).toHaveLength(0);
});

test("one person's pins are not another's", async () => {
  const { db, pins } = setup();
  await pins.pin(user("u1"), { artifactId: ID.wa, surface: "sidebar" });
  await pins.pin(user("u2"), { artifactId: ID.wb, surface: "sidebar" });

  expect((await pins.list(user("u1"))).map((row) => row.artifactId)).toEqual([
    ID.wa,
  ]);
  expect((await pins.list(user("u2"))).map((row) => row.artifactId)).toEqual([
    ID.wb,
  ]);

  await pins.unpin(user("u2"), { artifactId: ID.wa, surface: "sidebar" });
  expect(pinRows(db)).toHaveLength(2);
});

test("a private artifact of another person is not_found, an admin may pin it", async () => {
  const { pins } = setup();
  const error = await rejectionOf(
    pins.pin(user("u1"), { artifactId: ID.pb, surface: "sidebar" })
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe("not_found");

  await pins.pin(user("u1"), { artifactId: ID.wa, surface: "sidebar" });
  await pins.pin(user("admin", "w1", true), {
    artifactId: ID.pb,
    surface: "sidebar",
  });
  expect(
    (await pins.list(user("admin", "w1", true))).map((row) => row.artifactId)
  ).toEqual([ID.pb]);
});

test("list leaves out a pin once the artifact turns private for a non-owner", async () => {
  const { db, pins } = setup();
  await pins.pin(user("u2"), { artifactId: ID.wa, surface: "sidebar" });
  expect(await pins.list(user("u2"))).toHaveLength(1);

  db.update(artifacts)
    .set({ audience: "private", ownerUserId: "u1" })
    .where(eq(artifacts.id, ID.wa))
    .run();
  expect(await pins.list(user("u2"))).toEqual([]);
  // The pin row stays; it is only hidden from the list.
  expect(pinRows(db)).toHaveLength(1);
});

test("list leaves out soft-deleted artifacts", async () => {
  const { db, pins } = setup();
  await pins.pin(user("u1"), { artifactId: ID.wb, surface: "sidebar" });
  db.update(artifacts)
    .set({ deletedAt: NOW })
    .where(eq(artifacts.id, ID.wb))
    .run();
  expect(await pins.list(user("u1"))).toEqual([]);
});

test("a principal from another workspace gets not_found", async () => {
  const { pins } = setup();
  const error = await rejectionOf(
    pins.pin(user("u1", "w2"), { artifactId: ID.wa, surface: "sidebar" })
  );
  expect(error).toBeInstanceOf(ServiceError);
  expect((error as ServiceError).code).toBe("not_found");
});

test("a non-user principal is Forbidden", async () => {
  const { pins } = setup();
  const run: Principal = {
    agentId: "agent_1",
    kind: "run",
    runId: "run_1",
    workspaceId: "w1",
  };
  const error = await rejectionOf(
    pins.pin(run, { artifactId: ID.wa, surface: "sidebar" })
  );
  expect(error).toBeInstanceOf(ForbiddenError);
});
