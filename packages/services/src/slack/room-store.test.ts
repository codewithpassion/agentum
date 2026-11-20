import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import { inboxPosts, inboxThreads } from "@repo/db/schema/inbox";
import {
  slackApps,
  slackRoomMessages,
  teamSlackLinks,
} from "@repo/db/schema/slack";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import {
  findRoomLink,
  findRoomTopic,
  isAppBotUser,
  roomAgentsByBotUser,
  roomMessageExists,
} from "./room-store.ts";

const START = "2026-10-16T10:00:00.000Z";
const T0 = "2026-10-16T10:00:00.000Z";
const T1 = "2026-10-16T10:01:00.000Z";
const T2 = "2026-10-16T10:02:00.000Z";
const T3 = "2026-10-16T10:03:00.000Z";
const LOOKUP_CAP = 50;

const W1 = "w1";
const W2 = "w2";
const SLACK_TEAM = "T0SLACK";
const CHANNEL = "C0ROOM";
const OTHER_CHANNEL = "C0OTHER";

const ROOM_TEAM = "team-room";
const OTHER_ROOM_TEAM = "team-other";
const ARCHIVED_TEAM = "team-archived";
const W2_TEAM = "team-w2";

const AGENT_IN = "a-in";
const AGENT_OUT = "a-out";
const AGENT_ARCHIVED = "a-archived";
const AGENT_REVOKED = "a-revoked";

const TOPIC_A = "topic-a";
const TOPIC_B = "topic-b";
const TOPIC_OTHER = "topic-other";
const POST_A = "post-a";
const POST_B = "post-b";
const POST_OTHER = "post-other";

const THREAD_A = "1700000000.000100";
const THREAD_B = "1700000000.000200";
const REPLY_B = "1700000000.000201";
const REPLY_OTHER = "1700000000.000202";
const UNKNOWN_THREAD = "1700000000.999999";

let db: ReturnType<typeof migrated>;

const insertRoomMessage = (row: {
  channelId?: string;
  createdAt: string;
  id: string;
  postId: string;
  threadTs: string | null;
  ts: string;
}) =>
  db
    .insert(slackRoomMessages)
    .values({
      channelId: row.channelId ?? CHANNEL,
      createdAt: row.createdAt,
      direction: "in",
      id: row.id,
      postId: row.postId,
      slackTeamId: SLACK_TEAM,
      threadTs: row.threadTs,
      ts: row.ts,
      workspaceId: W1,
    })
    .run();

const insertApp = (
  id: string,
  agentId: string,
  botUserId: string,
  status: "installed" | "revoked"
) =>
  db
    .insert(slackApps)
    .values({
      agentId,
      appId: `A_${id}`,
      botUserId,
      createdAt: START,
      id,
      signingSecret: "ciphertext",
      status,
      teamId: SLACK_TEAM,
      workspaceId: W1,
    })
    .run();

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

  for (const [id, status] of [
    [AGENT_IN, "active"],
    [AGENT_OUT, "active"],
    [AGENT_ARCHIVED, "archived"],
    [AGENT_REVOKED, "active"],
  ] as const) {
    db.insert(agentRows)
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
  }

  db.insert(teams)
    .values([
      {
        createdAt: START,
        id: ROOM_TEAM,
        name: "Room",
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
        memberId: AGENT_REVOKED,
        memberKind: "agent",
        teamId: ROOM_TEAM,
        workspaceId: W1,
      },
    ])
    .run();

  insertApp("app-in", AGENT_IN, "U_IN", "installed");
  insertApp("app-out", AGENT_OUT, "U_OUT", "installed");
  insertApp("app-archived", AGENT_ARCHIVED, "U_ARCHIVED", "installed");
  insertApp("app-revoked", AGENT_REVOKED, "U_REVOKED", "revoked");

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
        id: TOPIC_OTHER,
        lastPostAt: START,
        teamId: OTHER_ROOM_TEAM,
        title: "Other",
        workspaceId: W1,
      },
    ])
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
        id: POST_OTHER,
        text: "other",
        threadId: TOPIC_OTHER,
        workspaceId: W1,
      },
    ])
    .run();
});

test("findRoomLink returns the team a channel is linked to", async () => {
  expect(
    await findRoomLink(db, {
      channelId: CHANNEL,
      slackTeamId: SLACK_TEAM,
      workspaceId: W1,
    })
  ).toEqual({ teamId: ROOM_TEAM });
});

test("findRoomLink returns null for an unlinked channel", async () => {
  expect(
    await findRoomLink(db, {
      channelId: OTHER_CHANNEL,
      slackTeamId: SLACK_TEAM,
      workspaceId: W1,
    })
  ).toBeNull();
});

test("findRoomLink ignores a link in another workspace", async () => {
  expect(
    await findRoomLink(db, {
      channelId: "C0W2",
      slackTeamId: SLACK_TEAM,
      workspaceId: W1,
    })
  ).toBeNull();
  expect(
    await findRoomLink(db, {
      channelId: "C0W2",
      slackTeamId: SLACK_TEAM,
      workspaceId: W2,
    })
  ).toEqual({ teamId: W2_TEAM });
});

test("findRoomLink returns null when the linked team is archived", async () => {
  expect(
    await findRoomLink(db, {
      channelId: "C0ARCHIVED",
      slackTeamId: SLACK_TEAM,
      workspaceId: W1,
    })
  ).toBeNull();
});

test("roomMessageExists is true for a stored Slack message", async () => {
  insertRoomMessage({
    createdAt: T1,
    id: "m1",
    postId: POST_A,
    threadTs: null,
    ts: THREAD_A,
  });

  expect(
    await roomMessageExists(db, {
      channelId: CHANNEL,
      slackTeamId: SLACK_TEAM,
      ts: THREAD_A,
    })
  ).toBe(true);
});

test("roomMessageExists is false for a message not stored or in another channel", async () => {
  insertRoomMessage({
    createdAt: T1,
    id: "m1",
    postId: POST_A,
    threadTs: null,
    ts: THREAD_A,
  });

  expect(
    await roomMessageExists(db, {
      channelId: CHANNEL,
      slackTeamId: SLACK_TEAM,
      ts: UNKNOWN_THREAD,
    })
  ).toBe(false);
  expect(
    await roomMessageExists(db, {
      channelId: OTHER_CHANNEL,
      slackTeamId: SLACK_TEAM,
      ts: THREAD_A,
    })
  ).toBe(false);
});

test("findRoomTopic finds the topic by the first message's ts", async () => {
  insertRoomMessage({
    createdAt: T1,
    id: "m1",
    postId: POST_A,
    threadTs: null,
    ts: THREAD_A,
  });

  expect(
    await findRoomTopic(db, {
      channelId: CHANNEL,
      slackTeamId: SLACK_TEAM,
      teamId: ROOM_TEAM,
      threadTs: THREAD_A,
    })
  ).toBe(TOPIC_A);
});

test("findRoomTopic finds the topic by a reply's thread_ts and ignores another team's topic", async () => {
  insertRoomMessage({
    createdAt: T0,
    id: "m-other",
    postId: POST_OTHER,
    threadTs: THREAD_B,
    ts: REPLY_OTHER,
  });
  insertRoomMessage({
    createdAt: T2,
    id: "m-b",
    postId: POST_B,
    threadTs: THREAD_B,
    ts: REPLY_B,
  });

  expect(
    await findRoomTopic(db, {
      channelId: CHANNEL,
      slackTeamId: SLACK_TEAM,
      teamId: ROOM_TEAM,
      threadTs: THREAD_B,
    })
  ).toBe(TOPIC_B);
  expect(
    await findRoomTopic(db, {
      channelId: CHANNEL,
      slackTeamId: SLACK_TEAM,
      teamId: OTHER_ROOM_TEAM,
      threadTs: THREAD_B,
    })
  ).toBe(TOPIC_OTHER);
});

test("findRoomTopic returns the topic of the earliest message in the thread", async () => {
  insertRoomMessage({
    createdAt: T3,
    id: "m-late",
    postId: POST_B,
    threadTs: THREAD_A,
    ts: REPLY_B,
  });
  insertRoomMessage({
    createdAt: T1,
    id: "m-first",
    postId: POST_A,
    threadTs: null,
    ts: THREAD_A,
  });

  expect(
    await findRoomTopic(db, {
      channelId: CHANNEL,
      slackTeamId: SLACK_TEAM,
      teamId: ROOM_TEAM,
      threadTs: THREAD_A,
    })
  ).toBe(TOPIC_A);
});

test("findRoomTopic returns null when no message of the thread is in the room", async () => {
  insertRoomMessage({
    createdAt: T1,
    id: "m1",
    postId: POST_A,
    threadTs: null,
    ts: THREAD_A,
  });

  expect(
    await findRoomTopic(db, {
      channelId: CHANNEL,
      slackTeamId: SLACK_TEAM,
      teamId: ROOM_TEAM,
      threadTs: UNKNOWN_THREAD,
    })
  ).toBeNull();
  expect(
    await findRoomTopic(db, {
      channelId: OTHER_CHANNEL,
      slackTeamId: SLACK_TEAM,
      teamId: ROOM_TEAM,
      threadTs: THREAD_A,
    })
  ).toBeNull();
});

test("roomAgentsByBotUser keeps an active member agent", async () => {
  const agents = await roomAgentsByBotUser(db, {
    botUserIds: ["U_IN"],
    slackTeamId: SLACK_TEAM,
    teamId: ROOM_TEAM,
    workspaceId: W1,
  });

  expect(agents).toEqual(new Map([["U_IN", AGENT_IN]]));
});

test("roomAgentsByBotUser drops a non-member, an archived agent, a revoked app and an unknown id", async () => {
  const agents = await roomAgentsByBotUser(db, {
    botUserIds: ["U_OUT", "U_ARCHIVED", "U_REVOKED", "U_NOPE", "U_IN"],
    slackTeamId: SLACK_TEAM,
    teamId: ROOM_TEAM,
    workspaceId: W1,
  });

  expect(agents).toEqual(new Map([["U_IN", AGENT_IN]]));
});

test("roomAgentsByBotUser returns an empty map for no ids", async () => {
  const agents = await roomAgentsByBotUser(db, {
    botUserIds: [],
    slackTeamId: SLACK_TEAM,
    teamId: ROOM_TEAM,
    workspaceId: W1,
  });

  expect(agents.size).toBe(0);
});

test("roomAgentsByBotUser looks at no more than the first 50 ids", async () => {
  const fillers = Array.from(
    { length: LOOKUP_CAP },
    (_, index) => `U_FILLER_${index}`
  );
  const agents = await roomAgentsByBotUser(db, {
    botUserIds: [...fillers, "U_IN"],
    slackTeamId: SLACK_TEAM,
    teamId: ROOM_TEAM,
    workspaceId: W1,
  });

  expect(agents.size).toBe(0);
});

test("isAppBotUser is true for an installed app's bot user", async () => {
  expect(
    await isAppBotUser(db, {
      slackTeamId: SLACK_TEAM,
      userId: "U_IN",
      workspaceId: W1,
    })
  ).toBe(true);
});

test("isAppBotUser is false for a revoked app, an unknown id or another workspace", async () => {
  expect(
    await isAppBotUser(db, {
      slackTeamId: SLACK_TEAM,
      userId: "U_REVOKED",
      workspaceId: W1,
    })
  ).toBe(false);
  expect(
    await isAppBotUser(db, {
      slackTeamId: SLACK_TEAM,
      userId: "U_NOPE",
      workspaceId: W1,
    })
  ).toBe(false);
  expect(
    await isAppBotUser(db, {
      slackTeamId: SLACK_TEAM,
      userId: "U_IN",
      workspaceId: W2,
    })
  ).toBe(false);
});
