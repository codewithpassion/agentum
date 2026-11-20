import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import {
  inboxPosts,
  inboxThreadMembers,
  inboxThreads,
} from "@repo/db/schema/inbox";
import { slackRoomMessages, teamSlackLinks } from "@repo/db/schema/slack";
import { teamMembers, teams } from "@repo/db/schema/teams";
import {
  identityLinks,
  workspaces as workspaceRows,
} from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { searchRoomMessages } from "./room-search.ts";

const WORKSPACE = "w1";
const SLACK_TEAM = "T0SLACK";
const TEAM = "team_room";
const OTHER_TEAM = "team_other";
const SECOND_TEAM = "team_second";
const MEMBER_AGENT = "a1";
const LEAD_AGENT = "a3";
const OUTSIDER_AGENT = "a2";
const START = "2026-10-16T10:00:00.000Z";
const ROOM_CHANNEL = "C0ROOM";
const SECOND_CHANNEL = "G0SECOND";
const UNLINKED_CHANNEL = "C0UNLINKED";
const ANN_EMAIL = "ann@example.test";
const ANN_CLERK = "user_ann";

let db: ReturnType<typeof migrated>;
let postCount: number;

/** A minute after START, so posts have distinct, ordered times. */
const at = (minute: number): string =>
  new Date(Date.parse(START) + minute * 60_000).toISOString();

const baseInput = {
  limit: 20,
  query: "deploy",
  slackTeamId: SLACK_TEAM,
  workspaceId: WORKSPACE,
};

interface PostSeed {
  authorId: string;
  authorKind: "agent" | "user";
  channelId: string;
  minute: number;
  /** The team of the topic. Defaults to the team the channel is linked to. */
  teamId?: string;
  text: string;
  threadId?: string;
  threadTs?: string | null;
  ts?: string;
}

/** Writes a post and the Slack message it is paired with. Each post gets its own thread unless one is given. */
const seedPost = (seed: PostSeed) => {
  postCount += 1;
  const threadId = seed.threadId ?? `th_${postCount}`;
  if (seed.threadId === undefined) {
    db.insert(inboxThreads)
      .values({
        createdAt: at(seed.minute),
        createdBy: ANN_CLERK,
        id: threadId,
        lastPostAt: at(seed.minute),
        teamId:
          seed.teamId ??
          (seed.channelId === SECOND_CHANNEL ? SECOND_TEAM : TEAM),
        title: "topic",
        workspaceId: WORKSPACE,
      })
      .run();
  }
  const postId = `p${postCount}`;
  db.insert(inboxPosts)
    .values({
      authorId: seed.authorId,
      authorKind: seed.authorKind,
      createdAt: at(seed.minute),
      id: postId,
      text: seed.text,
      threadId,
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(slackRoomMessages)
    .values({
      channelId: seed.channelId,
      createdAt: at(seed.minute),
      direction: seed.authorKind === "agent" ? "out" : "in",
      id: `srm${postCount}`,
      postId,
      slackTeamId: SLACK_TEAM,
      threadTs: seed.threadTs ?? null,
      ts: seed.ts ?? `1700000${String(postCount).padStart(3, "0")}.000100`,
      workspaceId: WORKSPACE,
    })
    .run();
};

const agentRow = (id: string, name: string) =>
  db
    .insert(agentRows)
    .values({
      createdAt: START,
      createdBy: "u1",
      id,
      instructions: "",
      model: "m",
      name,
      runtime: "fake",
      runtimeConfig: "{}",
      slug: name.toLowerCase(),
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();

beforeEach(() => {
  db = migrated();
  postCount = 0;
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  agentRow(MEMBER_AGENT, "Atlas");
  agentRow(OUTSIDER_AGENT, "Outsider");
  agentRow(LEAD_AGENT, "Lead");

  db.insert(teams)
    .values([
      {
        createdAt: START,
        id: TEAM,
        leadAgentId: LEAD_AGENT,
        name: "Room",
        slug: "room",
        workspaceId: WORKSPACE,
      },
      {
        createdAt: START,
        id: OTHER_TEAM,
        name: "Other",
        slug: "other",
        workspaceId: WORKSPACE,
      },
      {
        createdAt: START,
        id: SECOND_TEAM,
        name: "Second room",
        slug: "second",
        workspaceId: WORKSPACE,
      },
    ])
    .run();
  db.insert(teamMembers)
    .values([
      {
        memberId: MEMBER_AGENT,
        memberKind: "agent",
        teamId: TEAM,
        workspaceId: WORKSPACE,
      },
      {
        memberId: MEMBER_AGENT,
        memberKind: "agent",
        teamId: SECOND_TEAM,
        workspaceId: WORKSPACE,
      },
    ])
    .run();
  db.insert(teamSlackLinks)
    .values([
      {
        channelId: ROOM_CHANNEL,
        createdAt: START,
        id: "link1",
        linkedBy: ANN_CLERK,
        slackTeamId: SLACK_TEAM,
        teamId: TEAM,
        workspaceId: WORKSPACE,
      },
      {
        channelId: SECOND_CHANNEL,
        createdAt: START,
        id: "link2",
        linkedBy: ANN_CLERK,
        slackTeamId: SLACK_TEAM,
        teamId: SECOND_TEAM,
        workspaceId: WORKSPACE,
      },
    ])
    .run();
  db.insert(identityLinks)
    .values({
      clerkUserId: ANN_CLERK,
      createdAt: START,
      email: ANN_EMAIL,
      externalUserId: "U0ANN",
      id: "il1",
      provider: "slack",
      teamId: SLACK_TEAM,
      workspaceId: WORKSPACE,
    })
    .run();
});

const search = (input: Partial<Parameters<typeof searchRoomMessages>[1]>) =>
  searchRoomMessages(db, {
    agentId: MEMBER_AGENT,
    ...baseInput,
    ...input,
  });

test("finds an in message from a guest, with the guest name and the prefix stripped", async () => {
  seedPost({
    authorId: "slack:T0SLACK:U0GUEST",
    authorKind: "user",
    channelId: ROOM_CHANNEL,
    minute: 1,
    text: "Gina Guest (Slack guest): deploy the worker tonight",
    threadTs: null,
    ts: "1700000001.000100",
  });

  const hits = await search({ query: "worker" });

  expect(hits).toEqual([
    {
      channelId: ROOM_CHANNEL,
      clerkEmail: null,
      createdAt: at(1),
      slackUserId: "Gina Guest (Slack guest)",
      text: "deploy the worker tonight",
      threadTs: null,
      ts: "1700000001.000100",
    },
  ]);
});

test("finds an agent's out message, shown with the agent's name", async () => {
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 2,
    text: "Deploy finished, all checks passed",
  });

  const hits = await search({ query: "checks" });

  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({
    channelId: ROOM_CHANNEL,
    clerkEmail: null,
    slackUserId: "Atlas",
    text: "Deploy finished, all checks passed",
  });
});

test("an agent outside the team finds nothing of its room", async () => {
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 2,
    text: "deploy finished",
  });

  expect(await search({ agentId: OUTSIDER_AGENT })).toEqual([]);
});

test("the lead of the team finds the room even when it is not a member", async () => {
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 2,
    text: "deploy finished",
  });

  expect(await search({ agentId: LEAD_AGENT })).toHaveLength(1);
});

test("a channel filter keeps only that channel", async () => {
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 1,
    text: "deploy from the room",
  });
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: SECOND_CHANNEL,
    minute: 2,
    text: "deploy from the second channel",
  });

  const hits = await search({ channelId: SECOND_CHANNEL });

  expect(hits.map((hit) => hit.text)).toEqual([
    "deploy from the second channel",
  ]);
});

test("every word must be contained in the text", async () => {
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 1,
    text: "deploy the worker tonight",
  });
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 2,
    text: "deploy the billing job",
  });

  const hits = await search({ query: "deploy worker" });

  expect(hits.map((hit) => hit.text)).toEqual(["deploy the worker tonight"]);
});

test("a LIKE wildcard in the query matches that character only", async () => {
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 1,
    text: "deploy at 100% load",
  });
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 2,
    text: "deploy at 1000 load",
  });

  const hits = await search({ query: "100%" });

  expect(hits.map((hit) => hit.text)).toEqual(["deploy at 100% load"]);
});

test("the limit caps the hits, newest first", async () => {
  for (const minute of [1, 2, 3]) {
    seedPost({
      authorId: MEMBER_AGENT,
      authorKind: "agent",
      channelId: ROOM_CHANNEL,
      minute,
      text: `deploy ${minute}`,
    });
  }

  const hits = await search({ limit: 2 });

  expect(hits.map((hit) => hit.text)).toEqual(["deploy 3", "deploy 2"]);
});

test("a channel that is not linked finds nothing", async () => {
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: UNLINKED_CHANNEL,
    minute: 1,
    text: "deploy from an unlinked channel",
  });

  expect(await search({})).toEqual([]);
});

test("a topic limited to members is not searched", async () => {
  const threadId = "th_members";
  db.insert(inboxThreads)
    .values({
      createdAt: at(1),
      createdBy: ANN_CLERK,
      id: threadId,
      lastPostAt: at(1),
      teamId: TEAM,
      title: "private",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(inboxThreadMembers)
    .values({
      memberId: ANN_CLERK,
      memberKind: "user",
      threadId,
      workspaceId: WORKSPACE,
    })
    .run();
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 1,
    text: "deploy in a members-only topic",
    threadId,
  });

  expect(await search({})).toEqual([]);
});

test("a person matches by the email of the linked account, or by the Slack name of an agent", async () => {
  seedPost({
    authorId: ANN_CLERK,
    authorKind: "user",
    channelId: ROOM_CHANNEL,
    minute: 1,
    text: "deploy is on hold",
  });
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 2,
    text: "deploy is queued",
  });

  const byEmail = await search({ person: "ANN@example.test" });
  const byAgent = await search({ person: "atlas" });

  expect(byEmail).toEqual([
    {
      channelId: ROOM_CHANNEL,
      clerkEmail: ANN_EMAIL,
      createdAt: at(1),
      slackUserId: ANN_EMAIL,
      text: "deploy is on hold",
      threadTs: null,
      ts: "1700000001.000100",
    },
  ]);
  expect(byAgent.map((hit) => hit.text)).toEqual(["deploy is queued"]);
});

test("since and until bound the post time, inclusive", async () => {
  for (const minute of [1, 2, 3]) {
    seedPost({
      authorId: MEMBER_AGENT,
      authorKind: "agent",
      channelId: ROOM_CHANNEL,
      minute,
      text: `deploy ${minute}`,
    });
  }

  const hits = await search({ since: at(2), until: at(2) });

  expect(hits.map((hit) => hit.text)).toEqual(["deploy 2"]);
});

test("a row of another workspace or Slack team is not searched", async () => {
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 1,
    text: "deploy from another Slack team",
  });

  expect(await search({ slackTeamId: "T0OTHER" })).toEqual([]);
  expect(await search({ workspaceId: "w2" })).toEqual([]);
});

test("a team that is not the linked one gets no hit", async () => {
  db.insert(teamMembers)
    .values({
      memberId: OUTSIDER_AGENT,
      memberKind: "agent",
      teamId: OTHER_TEAM,
      workspaceId: WORKSPACE,
    })
    .run();
  seedPost({
    authorId: MEMBER_AGENT,
    authorKind: "agent",
    channelId: ROOM_CHANNEL,
    minute: 1,
    text: "deploy for the room team",
  });

  expect(await search({ agentId: OUTSIDER_AGENT })).toEqual([]);
});

test("a post of an earlier team's topic is not found once the channel is linked to another team", async () => {
  // The channel was linked to OTHER_TEAM, then unlinked and linked to TEAM. The old rows stay.
  seedPost({
    authorId: "slack:T0SLACK:U0GUEST",
    authorKind: "user",
    channelId: ROOM_CHANNEL,
    minute: 1,
    teamId: OTHER_TEAM,
    text: "Gina Guest (Slack guest): deploy the old secret plan",
  });
  seedPost({
    authorId: "slack:T0SLACK:U0GUEST",
    authorKind: "user",
    channelId: ROOM_CHANNEL,
    minute: 2,
    text: "Gina Guest (Slack guest): deploy the new plan",
  });

  const hits = await search({ query: "deploy" });

  expect(hits.map((hit) => hit.text)).toEqual(["deploy the new plan"]);
});

test("a word of a guest's label does not match the guest's post", async () => {
  seedPost({
    authorId: "slack:T0SLACK:U0GUEST",
    authorKind: "user",
    channelId: ROOM_CHANNEL,
    minute: 1,
    text: "Gina Guest (Slack guest): deploy the worker tonight",
  });

  expect(await search({ query: "guest" })).toEqual([]);
  expect(await search({ query: "Gina" })).toEqual([]);
  expect(await search({ query: "worker" })).toHaveLength(1);
});
