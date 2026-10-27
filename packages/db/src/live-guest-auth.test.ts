import { Database as Sqlite } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { guestAuthRateBuckets } from "./schema/live-artifacts.ts";
import { workspaces } from "./schema/workspaces.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-10-27T00:00:00.000Z";
test("guest auth migration invalidates unbound legacy OTPs with foreign keys on", () => {
  const db = new Sqlite(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const directory = resolve(import.meta.dir, "../migrations");
  const files = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const target = files.find((name) =>
    readFileSync(resolve(directory, name), "utf8").includes(
      "CREATE TABLE `guest_auth_rate_buckets`"
    )
  );
  if (!target) {
    throw new Error("Missing guest auth migration");
  }
  for (const file of files.slice(0, files.indexOf(target))) {
    db.exec(readFileSync(resolve(directory, file), "utf8"));
  }
  db.run(
    "INSERT INTO workspaces (id, clerk_org_id, name, timezone, created_at) VALUES ('w', 'org', 'W', 'UTC', ?)",
    [NOW]
  );
  db.run(
    "INSERT INTO guest_identities (id, workspace_id, display_name, email, created_at) VALUES ('g', 'w', 'G', 'g@example.com', ?)",
    [NOW]
  );
  db.run(
    "INSERT INTO guest_codes (id, workspace_id, guest_id, code_hash, created_at, expires_at) VALUES ('legacy', 'w', 'g', 'old-hash', ?, ?)",
    [NOW, NOW]
  );
  db.exec(readFileSync(resolve(directory, target), "utf8"));
  expect(db.query("SELECT * FROM guest_codes").all()).toEqual([]);
  expect(db.query("SELECT * FROM guest_identities").all()).toHaveLength(1);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(() =>
    db.run(
      "INSERT INTO guest_codes (id, workspace_id, guest_id, code_hash, created_at, expires_at) VALUES ('new', 'w', 'g', 'hash', ?, ?)",
      [NOW, NOW]
    )
  ).toThrow("NOT NULL");
  db.close();
});

test("durable guest rate bucket schema enforces count, limits, uniqueness and tenant FK", () => {
  const db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org",
      createdAt: NOW,
      id: "w",
      name: "W",
      timezone: "UTC",
    })
    .run();
  const bucket = {
    count: 1,
    expiresAt: NOW,
    id: "b",
    kind: "invite" as const,
    limit: 2,
    subjectHash: "opaque",
    windowStart: 1,
    workspaceId: "w",
  };
  db.insert(guestAuthRateBuckets).values(bucket).run();
  expect(() =>
    db
      .insert(guestAuthRateBuckets)
      .values({ ...bucket, id: "other" })
      .run()
  ).toThrow("UNIQUE");
  expect(() =>
    db
      .insert(guestAuthRateBuckets)
      .values({ ...bucket, count: 3, id: "over", windowStart: 2 })
      .run()
  ).toThrow("CHECK");
  expect(() =>
    db
      .insert(guestAuthRateBuckets)
      .values({ ...bucket, id: "zero", limit: 0, windowStart: 3 })
      .run()
  ).toThrow("CHECK");
  expect(() =>
    db
      .insert(guestAuthRateBuckets)
      .values({ ...bucket, count: -1, id: "negative", windowStart: 4 })
      .run()
  ).toThrow("CHECK");
  expect(() =>
    db
      .insert(guestAuthRateBuckets)
      .values({ ...bucket, id: "foreign", workspaceId: "missing" })
      .run()
  ).toThrow("FOREIGN KEY");
});
