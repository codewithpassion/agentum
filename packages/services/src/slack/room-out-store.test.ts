import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import {
  inboxPosts,
  inboxThreadMembers,
  inboxThreads,
} from "@repo/db/schema/inbox";
import {
  slackApps,
  slackRoomMessages,
  teamSlackLinks,
} from "@repo/db/schema/slack";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import {
  findOutboundRoom,
  memberSenderApps,
  recordOutMessage,
  roomMessageOfPost,
  topicRootTs,
} from "./room-out-store.ts";

const START = "2026-10-16T10:00:00.000Z";
const EARLIER = "2026-10-15T09:00:00.000Z";
const T0 = "2026-10-16T10:00:00.000Z";
const T1 = "2026-10-16T10:01:00.000Z";
const T2 = "2026-10-16T10:02:00.000Z";
const T3 = "2026-10-16T10:03:00.000Z";

const W1 = "w1";
const W2 = "w2";
const SLACK_TEAM = "T0SLACK";
const OTHER_SLACK_TEAM = "T0OTHER";
const CHANNEL = "C0ROOM";

const ROOM_TEAM = "team-room";
const OTHER_ROOM_TEAM = "team-other";
const ARCHIVED_TEAM = "team-archived";
const UNLINKED_TEAM = "team-unlinked";
const W2_TEAM = "team-w2";

const LEAD = "a-lead";
const AGENT_IN = "a-in";
const AGENT_SECOND = "a-second";
const AGENT_OUT = "a-out";
const AGENT_ARCHIVED = "a-archived";
const AGENT_REVOKED = "a-revoked";
const OWNER = "user-owner";

const TOPIC_A = "topic-a";
const TOPIC_B = "topic-b";
const TOPIC_LIMITED = "topic-limited";
const TOPIC_NO_TEAM = "topic-no-team";
const TOPIC_ARCHIVED = "topic-archived";
const TOPIC_UNLINKED = "topic-unlinked";
const TOPIC_W2 = "topic-w2";
const TOPIC_OTHER = "topic-other";
const POST_A = "post-a";
const POST_B = "post-b";
const POST_LIMITED = "post-limited";
const POST_NO_TEAM = "post-no-team";
const POST_OTHER = "post-other";

const THREAD_A = "1700000000.000100";
const THREAD_B = "1700000000.000200";
const REPLY_A = "1700000000.000101";
const NEW_TS = "1700000000.000300";

let db: ReturnType<typeof migrated>;

const insertAgent = (id: string, status: "active" | "archived") =>
  db
    .insert(agentRows)
    .values({
      createdAt: START,
      createdBy: "u1",
      id,
      instructions: "",
      model: "m",
      name: id,
      runtime: "fake",
      runtimeConfig: "{}",
      slug: id,
      status,
      workspaceId: W1,
    })
    .run();

const insertApp = (
  id: string,
  agentId: string,
  status: "installed" | "revoked",
  options: { createdAt?: string; teamId?: string } = {}
) =>
  db
    .insert(slackApps)
    .values({
      agentId,
      appId: `A_${id}`,
      botUserId: `U_${id}`,
      createdAt: options.createdAt ?? START,
      id,
      signingSecret: "ciphertext",
      status,
      teamId: options.teamId ?? SLACK_TEAM,
      workspaceId: W1,
    })
    .run();

const insertRoomMessage = (row: {
  createdAt: string;
  id: string;
  postId: string;
  threadTs: string | null;
  ts: string;
  channelId?: string;
  slackTeamId?: string;
}) =>
  db
    .insert(slackRoomMessages)
    .values({
      channelId: row.channelId ?? CHANNEL,
      createdAt: row.createdAt,
      direction: "in",
      id: row.id,
      postId: row.postId,
      slackTeamId: row.slackTeamId ?? SLACK_TEAM,
      threadTs: row.threadTs,
      ts: row.ts,
      workspaceId: W1,
    })
    .run();

const rootOf = (
  threadId: string,
  channelId = CHANNEL,
  slackTeamId = SLACK_TEAM
) => topicRootTs(db, { channelId, slackTeamId, threadId });

beforeEach(() => {
  db = migrated();
  db.insert(workspaceRows)
    .values([
      {
        clerkOrgId: `org_${W1}`,
        createdAt: START,
        id: W1,
        name: W1,
        timezone: "UTC",
      },
      {
        clerkOrgId: `org_${W2}`,
        createdAt: START,
        id: W2,
        name: W2,
        timezone: "UTC",
      },
    ])
    .run();

  insertAgent(LEAD, "active");
  insertAgent(AGENT_IN, "active");
  insertAgent(AGENT_SECOND, "active");
  insertAgent(AGENT_OUT, "active");
  insertAgent(AGENT_REVOKED, "active");
  insertAgent(AGENT_ARCHIVED, "archived");

  db.insert(teams)
    .values([
      {
        createdAt: START,
        id: ROOM_TEAM,
        leadAgentId: LEAD,
        name: "Room",
        ownerUserId: OWNER,
        slug: "room",
        workspaceId: W1,
      },
      {
        createdAt: START,
        id: OTHER_ROOM_TEAM,
        name: "Other",
        slug: "other",
        workspaceId: W1,
      },
      {
        archivedAt: START,
        createdAt: START,
        id: ARCHIVED_TEAM,
        name: "Archived",
        slug: "archived",
        workspaceId: W1,
      },
      {
        createdAt: START,
        id: UNLINKED_TEAM,
        name: "Unlinked",
        slug: "unlinked",
        workspaceId: W1,
      },
      {
        createdAt: START,
        id: W2_TEAM,
        name: "Second",
        slug: "second",
        workspaceId: W2,
      },
    ])
    .run();

  db.insert(teamMembers)
    .values([
      {
        memberId: LEAD,
        memberKind: "agent",
        teamId: ROOM_TEAM,
        workspaceId: W1,
      },
      {
        memberId: AGENT_IN,
        memberKind: "agent",
        teamId: ROOM_TEAM,
        workspaceId: W1,
      },
      {
        memberId: AGENT_ARCHIVED,
        memberKind: "agent",
        teamId: ROOM_TEAM,
        workspaceId: W1,
      },
      {
        memberId: AGENT_SECOND,
        memberKind: "agent",
        teamId: ROOM_TEAM,
        workspaceId: W1,
      },
      {
        memberId: AGENT_REVOKED,
        memberKind: "agent",
        teamId: ROOM_TEAM,
        workspaceId: W1,
      },
    ])
    .run();

  insertApp("app-in", AGENT_IN, "installed");
  insertApp("app-out", AGENT_OUT, "installed");
  insertApp("app-archived", AGENT_ARCHIVED, "installed");
  insertApp("app-revoked", AGENT_REVOKED, "revoked");

  db.insert(teamSlackLinks)
    .values([
      {
        channelId: CHANNEL,
        createdAt: START,
        id: "link-room",
        linkedBy: "u1",
        slackTeamId: SLACK_TEAM,
        teamId: ROOM_TEAM,
        workspaceId: W1,
      },
      {
        channelId: "C0ARCHIVED",
        createdAt: START,
        id: "link-archived",
        linkedBy: "u1",
        slackTeamId: SLACK_TEAM,
        teamId: ARCHIVED_TEAM,
        workspaceId: W1,
      },
      {
        channelId: "C0OTHER",
        createdAt: START,
        id: "link-other",
        linkedBy: "u1",
        slackTeamId: SLACK_TEAM,
        teamId: OTHER_ROOM_TEAM,
        workspaceId: W1,
      },
      {
        channelId: "C0W2",
        createdAt: START,
        id: "link-w2",
        linkedBy: "u1",
        slackTeamId: SLACK_TEAM,
        teamId: W2_TEAM,
        workspaceId: W2,
      },
    ])
    .run();

  db.insert(inboxThreads)
    .values([
      {
        createdAt: START,
        createdBy: "u1",
        id: TOPIC_A,
        lastPostAt: START,
        teamId: ROOM_TEAM,
        title: "A",
        workspaceId: W1,
      },
      {
        createdAt: START,
        createdBy: "u1",
        id: TOPIC_B,
        lastPostAt: START,
        teamId: ROOM_TEAM,
        title: "B",
        workspaceId: W1,
      },
      {
        createdAt: START,
        createdBy: "u1",
        id: TOPIC_LIMITED,
        lastPostAt: START,
        teamId: ROOM_TEAM,
        title: "Limited",
        workspaceId: W1,
      },
      {
        createdAt: START,
        createdBy: "u1",
        id: TOPIC_NO_TEAM,
        lastPostAt: START,
        teamId: null,
        title: "No team",
        workspaceId: W1,
      },
      {
        createdAt: START,
        createdBy: "u1",
        id: TOPIC_ARCHIVED,
        lastPostAt: START,
        teamId: ARCHIVED_TEAM,
        title: "Archived",
        workspaceId: W1,
      },
      {
        createdAt: START,
        createdBy: "u1",
        id: TOPIC_UNLINKED,
        lastPostAt: START,
        teamId: UNLINKED_TEAM,
        title: "Unlinked",
        workspaceId: W1,
      },
      {
        createdAt: START,
        createdBy: "u1",
        id: TOPIC_W2,
        lastPostAt: START,
        teamId: W2_TEAM,
        title: "Second",
        workspaceId: W2,
      },
      {
        createdAt: START,
        createdBy: "u1",
        id: TOPIC_OTHER,
        lastPostAt: START,
        teamId: OTHER_ROOM_TEAM,
        title: "Other",
        workspaceId: W1,
      },
    ])
    .run();

  db.insert(inboxThreadMembers)
    .values({
      memberId: "u2",
      memberKind: "user",
      threadId: TOPIC_LIMITED,
      workspaceId: W1,
    })
    .run();

  db.insert(inboxPosts)
    .values([
      {
        authorId: "u1",
        authorKind: "user",
        createdAt: START,
        id: POST_A,
        text: "a",
        threadId: TOPIC_A,
        workspaceId: W1,
      },
      {
        authorId: "u1",
        authorKind: "user",
        createdAt: START,
        id: POST_B,
        text: "b",
        threadId: TOPIC_B,
        workspaceId: W1,
      },
      {
        authorId: "u1",
        authorKind: "user",
        createdAt: START,
        id: POST_LIMITED,
        text: "limited",
        threadId: TOPIC_LIMITED,
        workspaceId: W1,
      },
      {
        authorId: "u1",
        authorKind: "user",
        createdAt: START,
        id: POST_NO_TEAM,
        text: "no team",
        threadId: TOPIC_NO_TEAM,
        workspaceId: W1,
      },
      {
        authorId: "u1",
        authorKind: "user",
        createdAt: START,
        id: POST_OTHER,
        text: "other",
        threadId: TOPIC_OTHER,
        workspaceId: W1,
      },
    ])
    .run();
});

test("findOutboundRoom returns the linked room of a topic with every field", async () => {
  expect(
    await findOutboundRoom(db, { threadId: TOPIC_A, workspaceId: W1 })
  ).toEqual({
    channelId: CHANNEL,
    leadAgentId: LEAD,
    ownerUserId: OWNER,
    slackTeamId: SLACK_TEAM,
    teamId: ROOM_TEAM,
    teamName: "Room",
  });
});

test("findOutboundRoom returns null when the team has no Slack link", async () => {
  expect(
    await findOutboundRoom(db, { threadId: TOPIC_UNLINKED, workspaceId: W1 })
  ).toBeNull();
});

test("findOutboundRoom returns null when the team is archived", async () => {
  expect(
    await findOutboundRoom(db, { threadId: TOPIC_ARCHIVED, workspaceId: W1 })
  ).toBeNull();
});

test("findOutboundRoom returns null for a limited topic", async () => {
  expect(
    await findOutboundRoom(db, { threadId: TOPIC_LIMITED, workspaceId: W1 })
  ).toBeNull();
});

test("findOutboundRoom returns null for a topic of another workspace", async () => {
  expect(
    await findOutboundRoom(db, { threadId: TOPIC_W2, workspaceId: W1 })
  ).toBeNull();
});

test("findOutboundRoom returns null for a topic with no team", async () => {
  expect(
    await findOutboundRoom(db, { threadId: TOPIC_NO_TEAM, workspaceId: W1 })
  ).toBeNull();
});

test("roomMessageOfPost returns the direction of a post's room message", async () => {
  await recordOutMessage(db, {
    channelId: CHANNEL,
    createdAt: T1,
    id: "m-out",
    postId: POST_A,
    slackTeamId: SLACK_TEAM,
    threadTs: null,
    ts: THREAD_A,
    workspaceId: W1,
  });

  expect(await roomMessageOfPost(db, POST_A)).toEqual({ direction: "out" });
});

test("roomMessageOfPost returns null for a post with no room message", async () => {
  expect(await roomMessageOfPost(db, POST_B)).toBeNull();
});

test("topicRootTs returns null for a topic with no room messages", async () => {
  expect(await rootOf(TOPIC_A)).toBeNull();
});

test("topicRootTs returns the ts of a top-level first message", async () => {
  insertRoomMessage({
    createdAt: T1,
    id: "m1",
    postId: POST_A,
    threadTs: null,
    ts: THREAD_A,
  });

  expect(await rootOf(TOPIC_A)).toBe(THREAD_A);
});

test("topicRootTs returns the thread_ts of a first message that is a reply", async () => {
  insertRoomMessage({
    createdAt: T1,
    id: "m1",
    postId: POST_A,
    threadTs: THREAD_A,
    ts: REPLY_A,
  });

  expect(await rootOf(TOPIC_A)).toBe(THREAD_A);
});

test("topicRootTs takes the earliest row even when it was inserted last", async () => {
  insertRoomMessage({
    createdAt: T3,
    id: "m-late",
    postId: POST_A,
    threadTs: null,
    ts: NEW_TS,
  });
  insertRoomMessage({
    createdAt: T1,
    id: "m-first",
    postId: POST_A,
    threadTs: null,
    ts: THREAD_A,
  });

  expect(await rootOf(TOPIC_A)).toBe(THREAD_A);
});

test("topicRootTs ignores the room messages of another topic", async () => {
  insertRoomMessage({
    createdAt: T0,
    id: "m-b",
    postId: POST_B,
    threadTs: null,
    ts: THREAD_B,
  });
  insertRoomMessage({
    createdAt: T1,
    id: "m-a",
    postId: POST_A,
    threadTs: null,
    ts: THREAD_A,
  });

  expect(await rootOf(TOPIC_A)).toBe(THREAD_A);
});

test("topicRootTs ignores messages from another channel or Slack workspace", async () => {
  insertRoomMessage({
    channelId: "C0OLD",
    createdAt: T0,
    id: "m-old-channel",
    postId: POST_A,
    threadTs: null,
    ts: THREAD_B,
  });
  insertRoomMessage({
    createdAt: T0,
    id: "m-old-team",
    postId: POST_A,
    slackTeamId: OTHER_SLACK_TEAM,
    threadTs: null,
    ts: REPLY_A,
  });

  expect(await rootOf(TOPIC_A)).toBeNull();
  expect(await rootOf(TOPIC_A, "C0OLD")).toBe(THREAD_B);
  expect(await rootOf(TOPIC_A, CHANNEL, OTHER_SLACK_TEAM)).toBe(REPLY_A);
});

test("memberSenderApps returns only installed apps", async () => {
  const senders = await memberSenderApps(db, {
    slackTeamId: SLACK_TEAM,
    teamId: ROOM_TEAM,
    workspaceId: W1,
  });

  expect(senders.map((sender) => sender.app.id)).toEqual(["app-in"]);
});

test("memberSenderApps returns only active agents", async () => {
  const senders = await memberSenderApps(db, {
    slackTeamId: SLACK_TEAM,
    teamId: ROOM_TEAM,
    workspaceId: W1,
  });

  expect(senders.map((sender) => sender.agentId)).not.toContain(AGENT_ARCHIVED);
});

test("memberSenderApps returns only agents that are members of the team", async () => {
  const senders = await memberSenderApps(db, {
    slackTeamId: SLACK_TEAM,
    teamId: ROOM_TEAM,
    workspaceId: W1,
  });

  expect(senders.map((sender) => sender.agentId)).not.toContain(AGENT_OUT);
});

test("memberSenderApps excludes apps of another Slack team", async () => {
  insertApp("app-other-slack", AGENT_IN, "installed", {
    teamId: OTHER_SLACK_TEAM,
  });
  const senders = await memberSenderApps(db, {
    slackTeamId: SLACK_TEAM,
    teamId: ROOM_TEAM,
    workspaceId: W1,
  });

  expect(senders.map((sender) => sender.app.id)).toEqual(["app-in"]);
});

test("memberSenderApps orders by the app's created_at, then id", async () => {
  insertApp("app-second", AGENT_SECOND, "installed", { createdAt: EARLIER });
  const senders = await memberSenderApps(db, {
    slackTeamId: SLACK_TEAM,
    teamId: ROOM_TEAM,
    workspaceId: W1,
  });

  expect(senders.map((sender) => sender.app.id)).toEqual([
    "app-second",
    "app-in",
  ]);
  expect(senders[0]).toMatchObject({
    agentId: AGENT_SECOND,
    agentName: AGENT_SECOND,
  });
});

test("recordOutMessage writes an out row for the Slack message", async () => {
  await recordOutMessage(db, {
    channelId: CHANNEL,
    createdAt: T1,
    id: "m-out",
    postId: POST_A,
    slackTeamId: SLACK_TEAM,
    threadTs: THREAD_A,
    ts: REPLY_A,
    workspaceId: W1,
  });

  const rows = await db.select().from(slackRoomMessages).all();
  expect(rows).toEqual([
    {
      channelId: CHANNEL,
      createdAt: T1,
      direction: "out",
      id: "m-out",
      postId: POST_A,
      slackTeamId: SLACK_TEAM,
      threadTs: THREAD_A,
      ts: REPLY_A,
      workspaceId: W1,
    },
  ]);
});

test("recordOutMessage leaves an existing row for the same Slack message alone", async () => {
  await recordOutMessage(db, {
    channelId: CHANNEL,
    createdAt: T1,
    id: "m-out",
    postId: POST_A,
    slackTeamId: SLACK_TEAM,
    threadTs: null,
    ts: THREAD_A,
    workspaceId: W1,
  });
  await recordOutMessage(db, {
    channelId: CHANNEL,
    createdAt: T2,
    id: "m-again",
    postId: POST_B,
    slackTeamId: SLACK_TEAM,
    threadTs: THREAD_B,
    ts: THREAD_A,
    workspaceId: W1,
  });

  const rows = await db.select().from(slackRoomMessages).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    createdAt: T1,
    id: "m-out",
    postId: POST_A,
    threadTs: null,
  });
});
