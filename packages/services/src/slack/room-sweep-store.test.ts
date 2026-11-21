import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import {
  inboxPosts,
  inboxThreadMembers,
  inboxThreads,
} from "@repo/db/schema/inbox";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { slackRoomMessages, teamSlackLinks } from "@repo/db/schema/slack";
import { teams } from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import {
  lostInboundPosts,
  SWEEP_LIMIT,
  unsentRoomPosts,
} from "./room-sweep-store.ts";

const W1 = "w1";
const AGENT = "agent-1";
const CHANNEL = "C0ROOM";
const SLACK_TEAM = "T0SLACK";

const ROOM_TEAM = "team-room";
const ARCHIVED_TEAM = "team-archived";
const UNLINKED_TEAM = "team-unlinked";

const THREAD = "thread-room";
const THREAD_ARCHIVED = "thread-archived";
const THREAD_UNLINKED = "thread-unlinked";
const THREAD_LIMITED = "thread-limited";

const EARLIER = "2026-10-15T09:00:00.000Z";
const BEFORE_WINDOW = "2026-10-16T08:00:00.000Z";
const RUN_BEFORE_POST = "2026-10-16T09:30:00.000Z";
const POST_AT = "2026-10-16T10:00:00.000Z";
const RUN_AFTER_POST = "2026-10-16T10:01:00.000Z";
const LINK_AFTER_POST = "2026-10-16T10:30:00.000Z";
const AFTER_WINDOW = "2026-10-16T12:00:00.000Z";

const WINDOW = {
  after: "2026-10-16T09:00:00.000Z",
  before: "2026-10-16T11:00:00.000Z",
};

let db: ReturnType<typeof migrated>;

interface PostOptions {
  authorKind?: "user" | "agent";
  createdAt?: string;
  guestName?: string | null;
  id?: string;
  text?: string;
  threadId?: string;
}

const insertPost = (options: PostOptions = {}) => {
  const id = options.id ?? "p-1";
  db.insert(inboxPosts)
    .values({
      authorId: options.authorKind === "agent" ? AGENT : "u1",
      authorKind: options.authorKind ?? "user",
      createdAt: options.createdAt ?? POST_AT,
      guestName: options.guestName ?? null,
      id,
      text: options.text ?? "hello",
      threadId: options.threadId ?? THREAD,
      workspaceId: W1,
    })
    .run();
  return id;
};

const insertRoomMessage = (
  postId: string,
  direction: "in" | "out",
  createdAt = POST_AT
) =>
  db
    .insert(slackRoomMessages)
    .values({
      channelId: CHANNEL,
      createdAt,
      direction,
      id: `rm-${postId}-${direction}`,
      postId,
      slackTeamId: SLACK_TEAM,
      threadTs: null,
      ts: `ts-${postId}-${direction}`,
      workspaceId: W1,
    })
    .run();

const insertFailureEvent = (postId: string) =>
  db
    .insert(events)
    .values({
      actorId: "system",
      actorKind: "system",
      createdAt: POST_AT,
      id: `ev-${postId}`,
      payload: JSON.stringify({ postId }),
      type: "slack.room_send_failed",
      workspaceId: W1,
    })
    .run();

/** A post the lost-post sweep should return, unless a test breaks one rule. */
const insertInboundPost = (options: PostOptions = {}) => {
  const id = insertPost(options);
  insertRoomMessage(id, "in");
  return id;
};

const insertRun = (id: string, createdAt: string) => {
  db.insert(runs)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: AGENT,
      createdAt,
      id,
      inputText: "wake",
      sessionId: "session-thread",
      status: "done",
      workspaceId: W1,
    })
    .run();
  // Starting a run moves its session's lastRunAt in the same write.
  db.update(sessions)
    .set({ lastRunAt: createdAt })
    .where(eq(sessions.id, "session-thread"))
    .run();
};

beforeEach(() => {
  db = migrated();
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${W1}`,
      createdAt: EARLIER,
      id: W1,
      name: W1,
      timezone: "UTC",
    })
    .run();

  db.insert(agentRows)
    .values({
      createdAt: EARLIER,
      createdBy: "u1",
      id: AGENT,
      instructions: "",
      model: "m",
      name: AGENT,
      runtime: "fake",
      runtimeConfig: "{}",
      slug: AGENT,
      status: "active",
      workspaceId: W1,
    })
    .run();

  db.insert(teams)
    .values([
      {
        createdAt: EARLIER,
        id: ROOM_TEAM,
        name: "Room",
        slug: "room",
        workspaceId: W1,
      },
      {
        archivedAt: EARLIER,
        createdAt: EARLIER,
        id: ARCHIVED_TEAM,
        name: "Archived",
        slug: "archived",
        workspaceId: W1,
      },
      {
        createdAt: EARLIER,
        id: UNLINKED_TEAM,
        name: "Unlinked",
        slug: "unlinked",
        workspaceId: W1,
      },
    ])
    .run();

  db.insert(teamSlackLinks)
    .values([
      {
        channelId: CHANNEL,
        createdAt: EARLIER,
        id: "link-room",
        linkedBy: "u1",
        slackTeamId: SLACK_TEAM,
        teamId: ROOM_TEAM,
        workspaceId: W1,
      },
      {
        channelId: "C0ARCHIVED",
        createdAt: EARLIER,
        id: "link-archived",
        linkedBy: "u1",
        slackTeamId: SLACK_TEAM,
        teamId: ARCHIVED_TEAM,
        workspaceId: W1,
      },
    ])
    .run();

  db.insert(inboxThreads)
    .values([
      {
        createdAt: EARLIER,
        createdBy: "u1",
        id: THREAD,
        lastPostAt: EARLIER,
        teamId: ROOM_TEAM,
        title: "Room topic",
        workspaceId: W1,
      },
      {
        createdAt: EARLIER,
        createdBy: "u1",
        id: THREAD_ARCHIVED,
        lastPostAt: EARLIER,
        teamId: ARCHIVED_TEAM,
        title: "Archived topic",
        workspaceId: W1,
      },
      {
        createdAt: EARLIER,
        createdBy: "u1",
        id: THREAD_UNLINKED,
        lastPostAt: EARLIER,
        teamId: UNLINKED_TEAM,
        title: "Unlinked topic",
        workspaceId: W1,
      },
      {
        createdAt: EARLIER,
        createdBy: "u1",
        id: THREAD_LIMITED,
        lastPostAt: EARLIER,
        teamId: ROOM_TEAM,
        title: "Limited topic",
        workspaceId: W1,
      },
    ])
    .run();

  db.insert(inboxThreadMembers)
    .values({
      memberId: "u2",
      memberKind: "user",
      threadId: THREAD_LIMITED,
      workspaceId: W1,
    })
    .run();

  db.insert(sessions)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: AGENT,
      createdAt: EARLIER,
      externalKey: THREAD,
      id: "session-thread",
      origin: "inbox",
      workspaceId: W1,
    })
    .run();
});

test("lostInboundPosts returns an inbound person post no wake has seen", async () => {
  insertInboundPost({ id: "p-match" });

  expect(await lostInboundPosts(db, WINDOW)).toEqual(["p-match"]);
});

test("lostInboundPosts ignores posts outside the window", async () => {
  insertInboundPost({ createdAt: BEFORE_WINDOW, id: "p-old" });
  insertInboundPost({ createdAt: AFTER_WINDOW, id: "p-new" });
  insertInboundPost({ id: "p-match" });

  expect(await lostInboundPosts(db, WINDOW)).toEqual(["p-match"]);
});

test("lostInboundPosts excludes a guest post", async () => {
  insertInboundPost({ guestName: "Guest" });

  expect(await lostInboundPosts(db, WINDOW)).toEqual([]);
});

test("lostInboundPosts excludes an agent post", async () => {
  insertInboundPost({ authorKind: "agent" });

  expect(await lostInboundPosts(db, WINDOW)).toEqual([]);
});

test("lostInboundPosts excludes a post that a run answered after it was posted", async () => {
  insertInboundPost({ id: "p-answered" });
  insertRun("run-after", RUN_AFTER_POST);

  expect(await lostInboundPosts(db, WINDOW)).toEqual([]);
});

test("lostInboundPosts still returns a post that a run started before it", async () => {
  insertInboundPost({ id: "p-early-run" });
  insertRun("run-before", RUN_BEFORE_POST);

  expect(await lostInboundPosts(db, WINDOW)).toEqual(["p-early-run"]);
});

test("lostInboundPosts excludes a post with an inbox.loop_stopped event", async () => {
  const postId = insertInboundPost();
  db.insert(events)
    .values({
      actorId: "system",
      actorKind: "system",
      createdAt: POST_AT,
      id: "ev-stopped",
      payload: JSON.stringify({ postId }),
      type: "inbox.loop_stopped",
      workspaceId: W1,
    })
    .run();

  expect(await lostInboundPosts(db, WINDOW)).toEqual([]);
});

test("lostInboundPosts excludes a post whose team is not Slack-linked", async () => {
  insertInboundPost({ threadId: THREAD_UNLINKED });

  expect(await lostInboundPosts(db, WINDOW)).toEqual([]);
});

test("lostInboundPosts excludes a post whose team is archived", async () => {
  insertInboundPost({ threadId: THREAD_ARCHIVED });

  expect(await lostInboundPosts(db, WINDOW)).toEqual([]);
});

test("lostInboundPosts excludes a post posted before its team's Slack link", async () => {
  insertInboundPost();
  db.update(teamSlackLinks)
    .set({ createdAt: LINK_AFTER_POST })
    .where(eq(teamSlackLinks.teamId, ROOM_TEAM))
    .run();

  expect(await lostInboundPosts(db, WINDOW)).toEqual([]);
});

test("lostInboundPosts returns newest first", async () => {
  insertInboundPost({ id: "p-1" });
  insertInboundPost({ id: "p-3" });
  insertInboundPost({ id: "p-2" });

  expect(await lostInboundPosts(db, WINDOW)).toEqual(["p-3", "p-2", "p-1"]);
});

test("lostInboundPosts returns at most SWEEP_LIMIT posts", async () => {
  const total = SWEEP_LIMIT + 5;
  const ids = Array.from(
    { length: total },
    (_, index) => `p-${String(index + 1).padStart(3, "0")}`
  );
  db.insert(inboxPosts)
    .values(
      ids.map((id) => ({
        authorId: "u1",
        authorKind: "user" as const,
        createdAt: POST_AT,
        id,
        text: "hello",
        threadId: THREAD,
        workspaceId: W1,
      }))
    )
    .run();
  db.insert(slackRoomMessages)
    .values(
      ids.map((id) => ({
        channelId: CHANNEL,
        createdAt: POST_AT,
        direction: "in" as const,
        id: `rm-${id}`,
        postId: id,
        slackTeamId: SLACK_TEAM,
        threadTs: null,
        ts: `ts-${id}`,
        workspaceId: W1,
      }))
    )
    .run();

  const found = await lostInboundPosts(db, WINDOW);
  expect(found).toHaveLength(SWEEP_LIMIT);
  expect(found[0]).toBe(ids[total - 1] ?? "");
  expect(found.at(-1)).toBe(ids[total - SWEEP_LIMIT] ?? "");
});

test("unsentRoomPosts returns a room post that never went to Slack", async () => {
  insertPost({ id: "p-match" });

  expect(await unsentRoomPosts(db, WINDOW)).toEqual(["p-match"]);
});

test("unsentRoomPosts ignores posts outside the window", async () => {
  insertPost({ createdAt: BEFORE_WINDOW, id: "p-old" });
  insertPost({ createdAt: AFTER_WINDOW, id: "p-new" });
  insertPost({ id: "p-match" });

  expect(await unsentRoomPosts(db, WINDOW)).toEqual(["p-match"]);
});

test("unsentRoomPosts excludes a post with an out room message", async () => {
  const postId = insertPost();
  insertRoomMessage(postId, "out");

  expect(await unsentRoomPosts(db, WINDOW)).toEqual([]);
});

test("unsentRoomPosts excludes a post with an in room message", async () => {
  const postId = insertPost();
  insertRoomMessage(postId, "in");

  expect(await unsentRoomPosts(db, WINDOW)).toEqual([]);
});

test("unsentRoomPosts excludes a post with a slack.room_send_failed event", async () => {
  const postId = insertPost();
  insertFailureEvent(postId);

  expect(await unsentRoomPosts(db, WINDOW)).toEqual([]);
});

test("unsentRoomPosts excludes a limited topic", async () => {
  insertPost({ threadId: THREAD_LIMITED });

  expect(await unsentRoomPosts(db, WINDOW)).toEqual([]);
});

test("unsentRoomPosts excludes a post whose team has no Slack link", async () => {
  insertPost({ threadId: THREAD_UNLINKED });

  expect(await unsentRoomPosts(db, WINDOW)).toEqual([]);
});

test("unsentRoomPosts excludes a post posted before its team's Slack link", async () => {
  insertPost();
  db.update(teamSlackLinks)
    .set({ createdAt: LINK_AFTER_POST })
    .where(eq(teamSlackLinks.teamId, ROOM_TEAM))
    .run();

  expect(await unsentRoomPosts(db, WINDOW)).toEqual([]);
});

test("unsentRoomPosts excludes a guest post", async () => {
  insertPost({ guestName: "Guest" });

  expect(await unsentRoomPosts(db, WINDOW)).toEqual([]);
});

test("unsentRoomPosts excludes an empty post", async () => {
  insertPost({ text: "" });

  expect(await unsentRoomPosts(db, WINDOW)).toEqual([]);
});

test("unsentRoomPosts returns newest first", async () => {
  insertPost({ id: "p-1" });
  insertPost({ id: "p-3" });
  insertPost({ id: "p-2" });

  expect(await unsentRoomPosts(db, WINDOW)).toEqual(["p-3", "p-2", "p-1"]);
});

test("unsentRoomPosts returns at most SWEEP_LIMIT posts", async () => {
  const total = SWEEP_LIMIT + 5;
  const ids = Array.from(
    { length: total },
    (_, index) => `p-${String(index + 1).padStart(3, "0")}`
  );
  db.insert(inboxPosts)
    .values(
      ids.map((id) => ({
        authorId: "u1",
        authorKind: "user" as const,
        createdAt: POST_AT,
        id,
        text: "hello",
        threadId: THREAD,
        workspaceId: W1,
      }))
    )
    .run();

  const found = await unsentRoomPosts(db, WINDOW);
  expect(found).toHaveLength(SWEEP_LIMIT);
  expect(found[0]).toBe(ids[total - 1] ?? "");
  expect(found.at(-1)).toBe(ids[total - SWEEP_LIMIT] ?? "");
});
