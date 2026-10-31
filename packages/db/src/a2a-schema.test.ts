import { beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { a2aAgentCards, a2aConnections, a2aTasks } from "./schema/a2a.ts";
import { agents } from "./schema/agents.ts";
import { events } from "./schema/events.ts";
import { workspaces } from "./schema/workspaces.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-01-01T00:00:00.000Z";

let db: ReturnType<typeof migrated>;

const agent = (id: string) => ({
  createdAt: NOW,
  createdBy: "u1",
  id,
  instructions: "",
  model: "m",
  name: id,
  runtime: "fake" as const,
  runtimeConfig: "{}",
  slug: id,
  status: "active",
  workspaceId: "w1",
});

const card = (agentId: string, publicId: string) => ({
  agentId,
  description: "",
  id: `card-${agentId}`,
  publicId,
  publishedAt: NOW,
  publishedBy: "u1",
  skills: "[]",
  workspaceId: "w1",
});

beforeEach(() => {
  db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: NOW,
      id: "w1",
      name: "w1",
      timezone: "UTC",
    })
    .run();
  db.insert(agents)
    .values([agent("a1"), agent("a2")])
    .run();
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
});

test("the events triggers survive the A2A migration: UPDATE throws", () => {
  expect(() =>
    db
      .update(events)
      .set({ type: "run.failed" })
      .where(eq(events.id, "e1"))
      .run()
  ).toThrow("events is append-only");
  expect(db.select().from(events).get()?.type).toBe("run.queued");
});

test("a peer's message id is unique per connection", () => {
  db.insert(a2aConnections)
    .values({
      createdAt: NOW,
      createdBy: "u1",
      id: "c1",
      localAgentId: "a1",
      peerKind: "a2a_inbound",
      slug: "peer",
      status: "active",
      workspaceId: "w1",
    })
    .run();
  const task = {
    connectionId: "c1",
    contextId: "ctx1",
    createdAt: NOW,
    inputText: "hi",
    messageId: "m1",
    updatedAt: NOW,
    workspaceId: "w1",
  };
  db.insert(a2aTasks)
    .values({ ...task, id: "t1" })
    .run();
  expect(() =>
    db
      .insert(a2aTasks)
      .values({ ...task, id: "t2" })
      .run()
  ).toThrow("UNIQUE constraint failed");
  expect(db.select().from(a2aTasks).all()).toHaveLength(1);
});

test("a card's public id is unique", () => {
  db.insert(a2aAgentCards).values(card("a1", "pub1")).run();
  expect(() =>
    db.insert(a2aAgentCards).values(card("a2", "pub1")).run()
  ).toThrow("UNIQUE constraint failed");
  expect(db.select().from(a2aAgentCards).all()).toHaveLength(1);
});
