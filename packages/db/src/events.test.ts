import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { events } from "./schema/events.ts";
import { migrated } from "./test-db.ts";

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
  db.insert(events)
    .values({
      actorId: "u1",
      actorKind: "user",
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "e1",
      type: "run.queued",
      workspaceId: "w1",
    })
    .run();
});

test("events can be inserted", () => {
  expect(db.select().from(events).all()).toHaveLength(1);
});

test("UPDATE events throws", () => {
  expect(() =>
    db
      .update(events)
      .set({ type: "run.failed" })
      .where(eq(events.id, "e1"))
      .run()
  ).toThrow("events is append-only");
  expect(db.select().from(events).get()?.type).toBe("run.queued");
});

test("DELETE FROM events throws", () => {
  expect(() => db.delete(events).run()).toThrow("events is append-only");
  expect(db.select().from(events).all()).toHaveLength(1);
});
