import { expect, test } from "bun:test";
import { artifacts } from "./schema/artifacts.ts";
import {
  artifactComments,
  artifactCommentThreads,
  artifactMentionDeliveries,
} from "./schema/live-artifacts.ts";
import { workspaces } from "./schema/workspaces.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-10-27T00:00:00.000Z";

test("migrated mention intents enforce parents and recipient uniqueness without content storage", () => {
  const db = migrated();
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: NOW,
      id: "w1",
      name: "W1",
      timezone: "UTC",
    })
    .run();
  db.insert(artifacts)
    .values({
      audience: "private",
      createdAt: NOW,
      createdById: "u1",
      createdByKind: "user",
      id: "a1",
      kind: "document",
      ownerUserId: "u1",
      title: "Mention",
      updatedAt: NOW,
      workspaceId: "w1",
    })
    .run();
  db.insert(artifactCommentThreads)
    .values({ artifactId: "a1", id: "t1", workspaceId: "w1" })
    .run();
  db.insert(artifactComments)
    .values({
      authorId: "u1",
      authorKind: "user",
      body: "Member mention",
      createdAt: NOW,
      id: "c1",
      threadId: "t1",
      workspaceId: "w1",
    })
    .run();
  const delivery = {
    artifactId: "a1",
    commentId: "c1",
    createdAt: NOW,
    id: "d1",
    userId: "u2",
    workspaceId: "w1",
  };
  db.insert(artifactMentionDeliveries).values(delivery).run();
  expect(db.select().from(artifactMentionDeliveries).get()).toMatchObject({
    attempts: 0,
    completedAt: null,
    leaseToken: null,
    leaseUntil: null,
  });
  expect(() =>
    db
      .insert(artifactMentionDeliveries)
      .values({ ...delivery, id: "duplicate" })
      .run()
  ).toThrow();
  expect(() =>
    db
      .insert(artifactMentionDeliveries)
      .values({
        ...delivery,
        commentId: "missing",
        id: "bad-comment",
        userId: "u3",
      })
      .run()
  ).toThrow();
  expect(() =>
    db
      .insert(artifactMentionDeliveries)
      .values({
        ...delivery,
        artifactId: "missing",
        id: "bad-artifact",
        userId: "u3",
      })
      .run()
  ).toThrow();
  expect(() =>
    db
      .insert(artifactMentionDeliveries)
      .values({
        ...delivery,
        id: "bad-workspace",
        userId: "u3",
        workspaceId: "missing",
      })
      .run()
  ).toThrow();
  const columns = db.client
    .query<{ name: string }, []>(
      "PRAGMA table_info(artifact_mention_deliveries)"
    )
    .all()
    .map((column) => column.name);
  expect(columns.sort()).toEqual([
    "artifact_id",
    "attempts",
    "comment_id",
    "completed_at",
    "created_at",
    "id",
    "lease_token",
    "lease_until",
    "user_id",
    "workspace_id",
  ]);
  expect(
    db.client
      .query<{ name: string }, []>(
        "PRAGMA index_list(artifact_mention_deliveries)"
      )
      .all()
      .map((index) => index.name)
  ).toContain("artifact_mention_deliveries_pending_idx");
});
