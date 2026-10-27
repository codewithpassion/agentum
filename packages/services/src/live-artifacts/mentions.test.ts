import { expect, test } from "bun:test";
import { artifacts } from "@repo/db/schema/artifacts";
import {
  artifactComments,
  artifactMembers,
  artifactMentionDeliveries,
} from "@repo/db/schema/live-artifacts";
import { eq } from "drizzle-orm";
import { principals } from "../artifacts/test-harness";
import { SYSTEM_PRINCIPAL } from "../workspaces";
import { createLiveArtifactsWithAsk } from "./factory";
import { interactionFixture } from "./interaction-fixture";
import type { MentionEmail } from "./mentions";

const setup = async () => {
  const h = interactionFixture();
  let time = Date.parse("2026-10-27T00:00:00Z");
  let active = true;
  let failure = false;
  let afterSend: (() => void) | undefined;
  const captured: MentionEmail[] = [];
  const service = createLiveArtifactsWithAsk({
    ...h.deps,
    clock: { ...h.deps.clock, now: () => new Date(time) },
    mentions: {
      byEmail: async () =>
        active
          ? {
              email: "current@example.com",
              name: "Ann",
              principal: principals.stranger,
            }
          : null,
      recipient: async () =>
        active
          ? {
              email: "current@example.com",
              name: "Ann",
              principal: principals.stranger,
            }
          : null,
      send: async (mail) => {
        await Promise.resolve();
        if (failure) {
          throw new Error("transport unavailable");
        }
        captured.push(mail);
        afterSend?.();
      },
    },
  });
  const artifactId = await h.create();
  h.grant(artifactId);
  const post = (
    body = "Please review @[Ann](member:u2) and @[Ann](member:u2) @[Me](member:u1)"
  ) => service.comment(principals.owner, { artifactId, body });
  const sweep = () => service.retryMentions(SYSTEM_PRINCIPAL);
  const delivery = () => h.db.select().from(artifactMentionDeliveries).get();
  return {
    ...h,
    advance: () => {
      time += 61_000;
    },
    artifactId,
    captured,
    delivery,
    onSend: (callback: () => void) => {
      afterSend = callback;
    },
    post,
    service,
    setActive: (value: boolean) => {
      active = value;
    },
    setFailure: (value: boolean) => {
      failure = value;
    },
    sweep,
  };
};

test("comment and unique mention intents commit together; current member lookup emits bounded content once", async () => {
  const h = await setup();
  const { token } = await h.service.mentionMember(principals.owner, {
    artifactId: h.artifactId,
    email: "ann@example.com",
  });
  expect(token).toBe("@[Ann](member:u2)");
  await h.post();
  expect(h.db.select().from(artifactMentionDeliveries).all()).toHaveLength(1);
  expect(h.delivery()?.attempts).toBe(0);
  await Promise.all([h.sweep(), h.sweep()]);
  await h.sweep();
  expect(h.captured).toHaveLength(1);
  expect(h.captured[0]).toMatchObject({
    artifactId: h.artifactId,
    excerpt: "Please review @Ann and @Ann @Me",
    to: "current@example.com",
  });
  expect(h.delivery()?.completedAt).toBeTruthy();
  expect(h.delivery()?.attempts).toBe(1);
  expect(h.delivery()?.leaseToken).toBeNull();
});

test("mention insert failure rolls back comment, thread and intent", async () => {
  const h = await setup();
  h.db.run(
    "CREATE TRIGGER reject_mention BEFORE INSERT ON artifact_mention_deliveries BEGIN SELECT RAISE(ABORT, 'outbox failed'); END"
  );
  await expect(h.post()).rejects.toThrow();
  expect(h.db.select().from(artifactComments).all()).toHaveLength(0);
  expect(h.delivery()).toBeUndefined();
});

test("failed delivery retries after lease expiry; bounded to five claimed attempts", async () => {
  const h = await setup();
  await h.post();
  h.setFailure(true);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential retries exercise durable attempt cap
    await h.sweep();
    expect(h.delivery()?.attempts).toBe(attempt);
    await h.sweep();
    expect(h.delivery()?.attempts).toBe(attempt);
    h.advance();
  }
  h.setFailure(false);
  await h.sweep();
  expect(h.delivery()?.attempts).toBe(5);
  expect(h.captured).toHaveLength(0);
});

test("a transient failure followed by success acknowledges exactly the successful attempt", async () => {
  const h = await setup();
  await h.post();
  h.setFailure(true);
  await h.sweep();
  h.advance();
  h.setFailure(false);
  await h.sweep();
  await h.sweep();
  expect(h.captured).toHaveLength(1);
  expect(h.delivery()?.attempts).toBe(2);
  expect(h.delivery()?.completedAt).toBeTruthy();
});

test("a stale worker cannot acknowledge a newer lease; ambiguous success may duplicate mail", async () => {
  const h = await setup();
  await h.post();
  h.onSend(() => {
    h.db
      .update(artifactMentionDeliveries)
      .set({ leaseToken: "new-worker" })
      .run();
  });
  await h.sweep();
  expect(h.delivery()?.completedAt).toBeNull();
  expect(h.delivery()?.leaseToken).toBe("new-worker");
  h.onSend(() => undefined);
  h.advance();
  await h.sweep();
  expect(h.captured).toHaveLength(2);
  expect(h.captured[0]?.deliveryId).toBe(h.captured[1]?.deliveryId);
  expect(h.delivery()?.completedAt).toBeTruthy();
});

for (const removed of [
  "membership",
  "artifact-access",
  "comment",
  "artifact",
  "tenant-join",
] as const) {
  test(`delivery suppresses ${removed} changes before sending`, async () => {
    const h = await setup();
    const comment = await h.post();
    if (removed === "membership") {
      h.setActive(false);
    }
    if (removed === "artifact-access") {
      h.db
        .update(artifactMembers)
        .set({ revokedAt: "2026-10-27T00:00:00Z" })
        .run();
    }
    if (removed === "comment") {
      h.db
        .update(artifactComments)
        .set({ deletedAt: "2026-10-27T00:00:00Z" })
        .where(eq(artifactComments.id, comment.id))
        .run();
    }
    if (removed === "artifact") {
      h.db
        .update(artifacts)
        .set({ deletedAt: "2026-10-27T00:00:00Z" })
        .where(eq(artifacts.id, h.artifactId))
        .run();
    }
    if (removed === "tenant-join") {
      h.db.update(artifactMentionDeliveries).set({ workspaceId: "w2" }).run();
    }
    await h.sweep();
    expect(h.captured).toHaveLength(0);
  });
}
