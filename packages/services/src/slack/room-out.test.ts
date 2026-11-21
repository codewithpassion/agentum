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
import { memberProfiles, teamMembers, teams } from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { encryptSecret, importSecretsKey } from "../crypto.ts";
import type { EventInput, EventRecord } from "../events.ts";
import type { Clock } from "../runs/types.ts";
import { slackSecretBinding } from "./apps.ts";
import type { SlackFetch } from "./client.ts";
import { createRoomOutbound } from "./room-out.ts";
import { OUTBOUND_TEXT_MAX } from "./room-out-text.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";
const EARLIER = "2026-10-15T09:00:00.000Z";
const SLACK_API = "https://slack.com/api/";
const POST_METHOD = `${SLACK_API}chat.postMessage`;
const SLACK_TEAM = "T0SLACK";
const OTHER_SLACK_TEAM = "T0OTHER";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const POSTED_TS = "1700000000.000200";
const SLACK_ERROR = "slack.room_send_failed";
const NO_APP = "no_app";

const CHANNEL = "C0ROOM";
const NOAPP_CHANNEL = "C0NOAPP";
const PERSON_NAME = "Test Person";
const PERSON = "user-person";
const OWNER = "user-owner";
const LIMITED_MEMBER = "user-limited";

const LEAD = "agent-lead";
const SECOND = "agent-second";
const AUTHOR = "agent-author";
const FOREIGN = "agent-foreign";

const ROOM_TEAM = "team-room";
const UNLINKED_TEAM = "team-unlinked";
const NOAPP_TEAM = "team-noapp";

const TOPIC_MAIN = "topic-main";
const TOPIC_LIMITED = "topic-limited";
const TOPIC_UNLINKED = "topic-unlinked";
const TOPIC_NOAPP = "topic-noapp";

const LEAD_TOKEN = "Bearer xoxb-lead";
const SECOND_TOKEN = "Bearer xoxb-second";
const AUTHOR_TOKEN = "Bearer xoxb-author";

/** One request the fake Slack received. */
interface Recorded {
  authorization: string | null;
  body: Record<string, unknown> | null;
  url: string;
}

type Responder = (call: Recorded) => Response;

let db: ReturnType<typeof migrated>;
let calls: Recorded[];
let respond: Responder;
let appended: EventInput[];
let sleeps: number[];
let clock: Clock;

const json = (body: unknown): Response => Response.json(body);
const ok = (): Response => json({ ok: true, ts: POSTED_TS });
const rejected = (error: string): Response => json({ error, ok: false });

const slackFetch: SlackFetch = (url, init) => {
  const headers = new Headers(init.headers);
  const body =
    typeof init.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : null;
  const call: Recorded = {
    authorization: headers.get("Authorization"),
    body,
    url,
  };
  calls.push(call);
  return Promise.resolve(respond(call));
};

/** The `chat.postMessage` calls, in order. */
const posts = () => calls.filter((call) => call.url === POST_METHOD);

const recordAppend = (input: EventInput): Promise<EventRecord> => {
  appended.push(input);
  return Promise.resolve({} as EventRecord);
};

const outboundWith = (append: (input: EventInput) => Promise<EventRecord>) =>
  createRoomOutbound({
    clock,
    db,
    events: { append },
    fetch: slackFetch,
    secretsKey: SECRETS_KEY,
  });

const outbound = () => outboundWith(recordAppend);

const failureFor = (
  payload: Record<string, unknown>,
  agentId: string | null = null
): EventInput => ({
  actor: { id: "slack", kind: "system" },
  agentId,
  payload,
  type: SLACK_ERROR,
  workspaceId: WORKSPACE,
});

const postedEvent = (postId: string, threadId: string): EventRecord => ({
  actor: { id: PERSON, kind: "user" },
  agentId: null,
  createdAt: START,
  id: `event-${postId}`,
  payload: { postId, threadId },
  payloadRef: null,
  runId: null,
  seq: 1,
  sessionId: null,
  type: "inbox.posted",
  workspaceId: WORKSPACE,
});

const insertPost = (
  id: string,
  threadId: string,
  overrides: Partial<typeof inboxPosts.$inferInsert> = {}
) =>
  db
    .insert(inboxPosts)
    .values({
      authorId: PERSON,
      authorKind: "user",
      createdAt: START,
      id,
      text: "hello",
      threadId,
      workspaceId: WORKSPACE,
      ...overrides,
    })
    .run();

const insertApp = async (row: {
  agentId: string;
  createdAt: string;
  id: string;
  teamId: string;
  token: string;
}) => {
  const key = await importSecretsKey(SECRETS_KEY);
  const ref = { id: row.id, workspaceId: WORKSPACE };
  db.insert(slackApps)
    .values({
      agentId: row.agentId,
      appId: `A_${row.id}`,
      botToken: await encryptSecret(
        key,
        slackSecretBinding(ref, "bot_token"),
        row.token
      ),
      botUserId: `U_${row.id}`,
      createdAt: row.createdAt,
      id: row.id,
      signingSecret: "ciphertext",
      status: "installed",
      teamId: row.teamId,
      workspaceId: WORKSPACE,
    })
    .run();
};

const insertAgent = (id: string, name: string) =>
  db
    .insert(agentRows)
    .values({
      createdAt: START,
      createdBy: OWNER,
      id,
      instructions: "",
      model: "m",
      name,
      runtime: "fake",
      runtimeConfig: "{}",
      slug: id,
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();

beforeEach(async () => {
  db = migrated();
  calls = [];
  appended = [];
  sleeps = [];
  respond = () => ok();
  clock = {
    now: () => new Date(START),
    sleep: (ms: number) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };

  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();

  insertAgent(LEAD, "Lead Agent");
  insertAgent(SECOND, "Second Agent");
  insertAgent(AUTHOR, "Author Agent");
  insertAgent(FOREIGN, "Foreign Agent");

  db.insert(teams)
    .values([
      {
        createdAt: START,
        id: ROOM_TEAM,
        leadAgentId: LEAD,
        name: "Room",
        ownerUserId: OWNER,
        slug: "room",
        workspaceId: WORKSPACE,
      },
      {
        createdAt: START,
        id: UNLINKED_TEAM,
        name: "Unlinked",
        slug: "unlinked",
        workspaceId: WORKSPACE,
      },
      {
        createdAt: START,
        id: NOAPP_TEAM,
        name: "No app",
        slug: "noapp",
        workspaceId: WORKSPACE,
      },
    ])
    .run();

  db.insert(teamMembers)
    .values([
      {
        memberId: LEAD,
        memberKind: "agent",
        teamId: ROOM_TEAM,
        workspaceId: WORKSPACE,
      },
      {
        memberId: SECOND,
        memberKind: "agent",
        teamId: ROOM_TEAM,
        workspaceId: WORKSPACE,
      },
      {
        memberId: AUTHOR,
        memberKind: "agent",
        teamId: ROOM_TEAM,
        workspaceId: WORKSPACE,
      },
      {
        memberId: FOREIGN,
        memberKind: "agent",
        teamId: NOAPP_TEAM,
        workspaceId: WORKSPACE,
      },
    ])
    .run();

  // The second app is the oldest, so it is the first member app with no lead.
  await insertApp({
    agentId: LEAD,
    createdAt: START,
    id: "app-lead",
    teamId: SLACK_TEAM,
    token: "xoxb-lead",
  });
  await insertApp({
    agentId: SECOND,
    createdAt: EARLIER,
    id: "app-second",
    teamId: SLACK_TEAM,
    token: "xoxb-second",
  });
  await insertApp({
    agentId: AUTHOR,
    createdAt: START,
    id: "app-author",
    teamId: SLACK_TEAM,
    token: "xoxb-author",
  });
  await insertApp({
    agentId: FOREIGN,
    createdAt: START,
    id: "app-foreign",
    teamId: OTHER_SLACK_TEAM,
    token: "xoxb-foreign",
  });

  db.insert(teamSlackLinks)
    .values([
      {
        channelId: CHANNEL,
        createdAt: START,
        id: "link-room",
        linkedBy: OWNER,
        slackTeamId: SLACK_TEAM,
        teamId: ROOM_TEAM,
        workspaceId: WORKSPACE,
      },
      {
        channelId: NOAPP_CHANNEL,
        createdAt: START,
        id: "link-noapp",
        linkedBy: OWNER,
        slackTeamId: SLACK_TEAM,
        teamId: NOAPP_TEAM,
        workspaceId: WORKSPACE,
      },
    ])
    .run();

  db.insert(inboxThreads)
    .values([
      {
        createdAt: START,
        createdBy: OWNER,
        id: TOPIC_MAIN,
        lastPostAt: START,
        teamId: ROOM_TEAM,
        title: "Main",
        workspaceId: WORKSPACE,
      },
      {
        createdAt: START,
        createdBy: OWNER,
        id: TOPIC_LIMITED,
        lastPostAt: START,
        teamId: ROOM_TEAM,
        title: "Limited",
        workspaceId: WORKSPACE,
      },
      {
        createdAt: START,
        createdBy: OWNER,
        id: TOPIC_UNLINKED,
        lastPostAt: START,
        teamId: UNLINKED_TEAM,
        title: "Unlinked",
        workspaceId: WORKSPACE,
      },
      {
        createdAt: START,
        createdBy: OWNER,
        id: TOPIC_NOAPP,
        lastPostAt: START,
        teamId: NOAPP_TEAM,
        title: "No app",
        workspaceId: WORKSPACE,
      },
    ])
    .run();

  db.insert(inboxThreadMembers)
    .values({
      memberId: LIMITED_MEMBER,
      memberKind: "user",
      threadId: TOPIC_LIMITED,
      workspaceId: WORKSPACE,
    })
    .run();

  db.insert(memberProfiles)
    .values({
      handle: "test-person",
      name: PERSON_NAME,
      userId: PERSON,
      workspaceId: WORKSPACE,
    })
    .run();
});

test("a person's post goes out through the lead's app with the person's name in front", async () => {
  insertPost("post-person", TOPIC_MAIN);

  await outbound().onEvent(postedEvent("post-person", TOPIC_MAIN));

  const [call] = posts();
  expect(posts()).toHaveLength(1);
  expect(call?.authorization).toBe(LEAD_TOKEN);
  expect(call?.body).toMatchObject({
    channel: CHANNEL,
    text: `*${PERSON_NAME}:* hello`,
  });
  expect(call?.body?.thread_ts).toBeUndefined();
  expect(appended).toEqual([]);
  expect(
    db
      .select()
      .from(slackRoomMessages)
      .where(eq(slackRoomMessages.postId, "post-person"))
      .all()
  ).toMatchObject([
    {
      channelId: CHANNEL,
      direction: "out",
      threadTs: null,
      ts: POSTED_TS,
    },
  ]);
});

test("with no lead, the oldest member app sends a person's post", async () => {
  db.update(teams)
    .set({ leadAgentId: null })
    .where(eq(teams.id, ROOM_TEAM))
    .run();
  insertPost("post-person", TOPIC_MAIN);

  await outbound().onEvent(postedEvent("post-person", TOPIC_MAIN));

  expect(posts().map((call) => call.authorization)).toEqual([SECOND_TOKEN]);
  expect(posts()[0]?.body?.text).toBe(`*${PERSON_NAME}:* hello`);
});

test("an agent's post goes through that agent's own app with the plain text", async () => {
  insertPost("post-agent", TOPIC_MAIN, {
    authorId: AUTHOR,
    authorKind: "agent",
    text: "Hello from the agent",
  });

  await outbound().onEvent(postedEvent("post-agent", TOPIC_MAIN));

  expect(posts()).toHaveLength(1);
  expect(posts()[0]?.authorization).toBe(AUTHOR_TOKEN);
  expect(posts()[0]?.body?.text).toBe("Hello from the agent");
});

test("a post with a room message row, or a repeated event for a sent post, is sent once", async () => {
  insertPost("post-in", TOPIC_MAIN);
  db.insert(slackRoomMessages)
    .values({
      channelId: CHANNEL,
      createdAt: START,
      direction: "in",
      id: "msg-in",
      postId: "post-in",
      slackTeamId: SLACK_TEAM,
      threadTs: null,
      ts: "1700000000.000100",
      workspaceId: WORKSPACE,
    })
    .run();
  const sender = outbound();

  await sender.onEvent(postedEvent("post-in", TOPIC_MAIN));
  expect(posts()).toHaveLength(0);

  insertPost("post-sent", TOPIC_MAIN);
  await sender.onEvent(postedEvent("post-sent", TOPIC_MAIN));
  await sender.onEvent(postedEvent("post-sent", TOPIC_MAIN));

  expect(posts()).toHaveLength(1);
  expect(appended).toEqual([]);
});

test("a post that should not go to Slack sends nothing and raises no failure", async () => {
  insertPost("post-unlinked", TOPIC_UNLINKED);
  insertPost("post-limited", TOPIC_LIMITED);
  insertPost("post-blank", TOPIC_MAIN, { text: " \n\t " });
  insertPost("post-guest", TOPIC_MAIN, {
    authorId: "slack:U0GUEST",
    guestName: "Gina Guest",
  });
  const sender = outbound();

  await sender.onEvent(postedEvent("post-unlinked", TOPIC_UNLINKED));
  await sender.onEvent(postedEvent("post-limited", TOPIC_LIMITED));
  await sender.onEvent(postedEvent("post-blank", TOPIC_MAIN));
  await sender.onEvent(postedEvent("post-guest", TOPIC_MAIN));

  expect(calls).toEqual([]);
  expect(appended).toEqual([]);
});

test("no member app in the channel's Slack workspace records one no_app failure", async () => {
  insertPost("post-noapp", TOPIC_NOAPP);

  await outbound().onEvent(postedEvent("post-noapp", TOPIC_NOAPP));

  expect(calls).toEqual([]);
  expect(appended).toEqual([
    failureFor({
      channelId: NOAPP_CHANNEL,
      error: NO_APP,
      postId: "post-noapp",
      slackTeamId: SLACK_TEAM,
      teamId: NOAPP_TEAM,
      threadId: TOPIC_NOAPP,
    }),
  ]);
});

test("not_in_channel hands the post to the next app with the name in front, and fails once every app refuses", async () => {
  respond = (call) =>
    call.authorization === LEAD_TOKEN ? rejected("not_in_channel") : ok();
  insertPost("post-next", TOPIC_MAIN);

  await outbound().onEvent(postedEvent("post-next", TOPIC_MAIN));

  expect(posts().map((call) => call.authorization)).toEqual([
    LEAD_TOKEN,
    SECOND_TOKEN,
  ]);
  expect(posts()[1]?.body?.text).toBe(`*${PERSON_NAME}:* hello`);
  expect(appended).toEqual([]);

  calls = [];
  respond = () => rejected("not_in_channel");
  insertPost("post-refused", TOPIC_MAIN);

  await outbound().onEvent(postedEvent("post-refused", TOPIC_MAIN));

  expect(posts().map((call) => call.authorization)).toEqual([
    LEAD_TOKEN,
    SECOND_TOKEN,
    AUTHOR_TOKEN,
  ]);
  expect(appended).toEqual([
    failureFor({
      channelId: CHANNEL,
      error: "not_in_channel",
      postId: "post-refused",
      slackTeamId: SLACK_TEAM,
      teamId: ROOM_TEAM,
      threadId: TOPIC_MAIN,
    }),
  ]);
});

test("a 503 is tried three times with a wait between, then reported without trying the next app", async () => {
  respond = (call) =>
    call.authorization === LEAD_TOKEN
      ? new Response("", { status: 503 })
      : ok();
  insertPost("post-503", TOPIC_MAIN);

  await outbound().onEvent(postedEvent("post-503", TOPIC_MAIN));

  expect(posts().map((call) => call.authorization)).toEqual([
    LEAD_TOKEN,
    LEAD_TOKEN,
    LEAD_TOKEN,
  ]);
  expect(sleeps).toHaveLength(2);
  expect(appended).toEqual([
    failureFor({
      channelId: CHANNEL,
      error: "http_503",
      postId: "post-503",
      slackTeamId: SLACK_TEAM,
      teamId: ROOM_TEAM,
      threadId: TOPIC_MAIN,
    }),
  ]);
});

test("an agent's long text is cut to Slack's limit and its attachment markers are removed", async () => {
  const body = "a".repeat(OUTBOUND_TEXT_MAX + 100);
  insertPost("post-long", TOPIC_MAIN, {
    authorId: AUTHOR,
    authorKind: "agent",
    text: `Report ready [ATTACHMENT:/w/report.md]\n${body}`,
  });

  await outbound().onEvent(postedEvent("post-long", TOPIC_MAIN));

  const sent = posts()[0]?.body?.text;
  expect(typeof sent).toBe("string");
  expect(sent).toBe(
    `Report ready\n${"a".repeat(OUTBOUND_TEXT_MAX - "Report ready\n".length - 1)}…`
  );
  expect(String(sent)).not.toContain("[ATTACHMENT");
  expect(String(sent).length).toBe(OUTBOUND_TEXT_MAX);
});

test("other event types, and inbox.posted without a postId, do nothing, and a failing append does not throw", async () => {
  insertPost("post-noapp", TOPIC_NOAPP);
  const sender = outboundWith(() => Promise.reject(new Error("events down")));

  await sender.onEvent({
    ...postedEvent("post-noapp", TOPIC_NOAPP),
    type: "request.cancelled",
  });
  await sender.onEvent({
    ...postedEvent("post-noapp", TOPIC_NOAPP),
    payload: { threadId: TOPIC_NOAPP },
  });
  expect(calls).toEqual([]);
  expect(appended).toEqual([]);

  await expect(
    sender.onEvent(postedEvent("post-noapp", TOPIC_NOAPP))
  ).resolves.toBeUndefined();
  expect(calls).toEqual([]);
});
