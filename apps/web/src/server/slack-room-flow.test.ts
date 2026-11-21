/**
 * SL.5: the whole Slack link, both directions, with three member apps and the
 * fake Slack. Slack's events and button clicks reach the real route, the
 * agents run on the fake runtime, and their posts go out through the real
 * Slack client to the fake.
 */
import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { inboxPosts, inboxThreads } from "@repo/db/schema/inbox";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import {
  slackApps,
  slackMessages,
  slackRoomMessages,
} from "@repo/db/schema/slack";
import { identityLinks } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { encryptSecret, importSecretsKey } from "@repo/services/crypto";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import type { Clock } from "@repo/services/runs/types";
import { slackSecretBinding } from "@repo/services/slack/apps";
import {
  createFakeSlack,
  type Delivery,
  type FakeSlack,
  type FakeSlackApp,
} from "@repo/services/slack/fake-slack";
import { signSlackBody } from "@repo/services/slack/signature";
import { type Principal, SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Composed, composeWith } from "./compose.ts";
import type { AppEnv } from "./routes/groups.ts";
import { slackRoutes } from "./routes/slack.ts";

const ORG = "org_a";
const SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const SLACK_TEAM = "T0SL5E2E";
const CHANNEL = "C0ROOMSL5";
const OK = 200;
const DOM = "user_dom";
const DOM_SLACK = "U0DOM00001";
const DOM_EMAIL = "dom@example.test";
const GUEST_SLACK = "U0GUS00001";
const GUEST_NAME = "Gus Guest";

const appOf = (slug: string, name: string): FakeSlackApp => ({
  appId: `A0${slug.toUpperCase()}`,
  botId: `B0${slug.toUpperCase()}`,
  botUserId: `U0${slug.toUpperCase()}BOT`,
  name,
  signingSecret: `signing-${slug}`,
  token: `xoxb-${slug}`,
});

const ADA = appOf("ada", "Ada");
const CY = appOf("cy", "Cy");
const DI = appOf("di", "Di");

const clock: Clock = {
  now: () => new Date(),
  sleep: () => Promise.resolve(),
};

let db: ReturnType<typeof migrated>;
let composed: Composed;
let fake: FakeSlack;
let route: Hono<AppEnv>;
let deferred: (() => Promise<void>)[];
let workspaceId: string;
let owner: Principal;
/** When true, the directory knows Dom by his Slack email, as Clerk would. */
let directoryKnowsDom: boolean;
let dom: Principal;
let teamId: string;
const agentIds = new Map<string, string>();

/** Carries a signed delivery to the app's own route, as Slack's servers do. */
const deliver = async (delivery: Delivery): Promise<void> => {
  const isEvent = delivery.kind === "events";
  const response = await route.request(
    isEvent ? "/api/slack/events" : "/api/slack/interactions",
    {
      body: delivery.rawBody,
      headers: {
        "Content-Type": isEvent
          ? "application/json"
          : "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": delivery.timestamp,
        "X-Slack-Signature": delivery.signature,
      },
      method: "POST",
    }
  );
  if (response.status !== OK) {
    throw new Error(`The route answered ${response.status}.`);
  }
};

/** Runs deliveries and the work they defer until nothing is left to do. */
const settle = async (): Promise<void> => {
  await fake.settled();
  const jobs = deferred.splice(0);
  if (jobs.length === 0) {
    return;
  }
  await Promise.all(jobs.map((job) => job()));
  await settle();
};

const installApp = async (agentId: string, app: FakeSlackApp) => {
  const key = await importSecretsKey(SECRETS_KEY);
  const row = { id: `row_${app.appId}`, workspaceId };
  await db.insert(slackApps).values({
    agentId,
    appId: app.appId,
    botToken: await encryptSecret(
      key,
      slackSecretBinding(row, "bot_token"),
      app.token
    ),
    botUserId: app.botUserId,
    createdAt: new Date().toISOString(),
    id: row.id,
    signingSecret: await encryptSecret(
      key,
      slackSecretBinding(row, "signing_secret"),
      app.signingSecret
    ),
    status: "installed",
    teamId: SLACK_TEAM,
    workspaceId,
  });
};

const makeAgent = async (app: FakeSlackApp) => {
  const agent = await composed.services.agents.create(owner, {
    model: "fake",
    name: app.name,
    runtime: "fake",
  });
  agentIds.set(app.name, agent.id);
  await installApp(agent.id, app);
  return agent;
};

const posts = () =>
  db.select().from(inboxPosts).orderBy(asc(inboxPosts.id)).all();
const topics = () => db.select().from(inboxThreads).all();
const runs = () => db.select().from(runRows).all();
const slackPostsBy = (app: FakeSlackApp) =>
  fake.messages.filter((message) => message.appId === app.appId);

beforeEach(async () => {
  db = migrated([ORG]);
  deferred = [];
  directoryKnowsDom = false;
  agentIds.clear();
  fake = createFakeSlack({
    config: {
      apps: [ADA, CY, DI],
      channels: [
        {
          id: CHANNEL,
          isPrivate: false,
          // Di's app has not been invited yet.
          members: [DOM_SLACK, GUEST_SLACK, ADA.botUserId, CY.botUserId],
          name: "sl5-room",
        },
      ],
      slackTeamId: SLACK_TEAM,
      users: [
        { email: DOM_EMAIL, id: DOM_SLACK, name: "Dom Fretz" },
        { email: "gus@example.test", id: GUEST_SLACK, name: GUEST_NAME },
      ],
    },
    deliver,
  });
  composed = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: {
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
      },
      clock,
      devFakeRuntime: true,
      fetch: fake.fetch,
      fileBlobs: memoryFileBlobs(),
      people: (ids) =>
        Promise.resolve(
          new Map(
            ids.map((id) => [
              id,
              { email: null, name: id === DOM ? "Dom Fretz" : id },
            ])
          )
        ),
      publicBaseUrl: "https://agentum.test",
      relay: noopRelay,
      secretsKey: SECRETS_KEY,
      slackDirectory: {
        findUserIdByEmail: (email) =>
          Promise.resolve(
            directoryKnowsDom && email === DOM_EMAIL ? DOM : null
          ),
        isOrgMember: (userId) => Promise.resolve(userId === DOM),
      },
    },
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: ORG,
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  workspaceId = workspace.id;
  owner = {
    kind: "user",
    userId: "user_owner",
    via: "session",
    workspaceId,
  };
  dom = { kind: "user", userId: DOM, via: "session", workspaceId };
  route = new Hono<AppEnv>();
  route.use("*", async (c, next) => {
    c.set("composed", composed);
    await next();
  });
  route.route(
    "/api/slack",
    slackRoutes({ defer: (_c, job) => deferred.push(job) })
  );

  const ada = await makeAgent(ADA);
  const cy = await makeAgent(CY);
  const di = await makeAgent(DI);
  const team = await composed.services.teams.create(owner, {
    leadAgentId: ada.id,
    leadListens: true,
    name: "Launch",
  });
  teamId = team.id;
  for (const agent of [ada, cy, di]) {
    // biome-ignore lint/performance/noAwaitInLoops: three short setup steps, in order
    await composed.services.teams.addMember(owner, {
      memberId: agent.id,
      memberKind: "agent",
      teamId,
    });
  }
  await composed.services.teams.addMember(owner, {
    memberId: DOM,
    memberKind: "user",
    teamId,
  });
  await db.insert(identityLinks).values({
    clerkUserId: DOM,
    createdAt: new Date().toISOString(),
    email: DOM_EMAIL,
    externalUserId: DOM_SLACK,
    id: "link_dom",
    provider: "slack",
    teamId: SLACK_TEAM,
    workspaceId,
  });
});

const roomChannel = () => {
  const channel = fake.config.channels.find((entry) => entry.id === CHANNEL);
  if (!channel) {
    throw new Error("the fake has no room channel");
  }
  return channel;
};
const inviteDi = () => {
  roomChannel().members.push(DI.botUserId);
};
const removeDi = () => {
  const channel = roomChannel();
  channel.members = channel.members.filter((member) => member !== DI.botUserId);
};

const link = () =>
  composed.services.teams.slack.link(owner, {
    channelId: CHANNEL,
    slackTeamId: SLACK_TEAM,
    teamId,
  });

test("linking: the lead's app must be in the channel, and status names the app that is not", async () => {
  const before = await composed.services.teams.slack.channels(owner, teamId);
  expect(before.channels).toMatchObject([{ id: CHANNEL, name: "sl5-room" }]);

  await link();
  const status = await composed.services.teams.slack.status(owner, teamId);

  expect(status.link).toMatchObject({ channelId: CHANNEL });
  const inChannel = Object.fromEntries(
    status.apps.map((app) => [app.agentId, app.inChannel])
  );
  expect(inChannel).toEqual({
    [agentIds.get("Ada") as string]: true,
    [agentIds.get("Cy") as string]: true,
    [agentIds.get("Di") as string]: false,
  });

  // Di is invited in Slack, and the status follows.
  inviteDi();
  const after = await composed.services.teams.slack.status(owner, teamId);
  expect(after.apps.every((app) => app.inChannel)).toBe(true);
  expect(after.channelName).toBe("sl5-room");
});

test("Slack to room: every app hears the message, the room keeps one post, and the lead's answer goes back into the thread", async () => {
  await link();
  // Dom has no identity link yet: his first message links him by his Slack email.
  await db.delete(identityLinks);
  directoryKnowsDom = true;

  const first = fake.say({
    channel: CHANNEL,
    text: "Kickoff: plan the launch",
    user: DOM_SLACK,
  });
  await settle();

  // Two apps sit in the channel and each heard it, yet the room has one topic and one post.
  expect(topics()).toHaveLength(1);
  expect(topics()[0]).toMatchObject({
    teamId,
    title: "Kickoff: plan the launch",
  });
  const humanPosts = posts().filter((post) => post.authorKind === "user");
  expect(humanPosts).toMatchObject([{ authorId: DOM }]);
  expect(db.select().from(identityLinks).all()).toMatchObject([
    { clerkUserId: DOM, email: DOM_EMAIL, externalUserId: DOM_SLACK },
  ]);
  expect(fake.ephemerals).toEqual([]);

  // The lead heard it once (lead_listens) and answered in the Slack thread, through its own app.
  expect(
    runs().filter((run) => run.agentId === agentIds.get("Ada"))
  ).toHaveLength(1);
  expect(
    runs().filter((run) => run.agentId === agentIds.get("Cy"))
  ).toHaveLength(0);
  const answers = slackPostsBy(ADA);
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ channel: CHANNEL, threadTs: first.ts });
  expect(slackPostsBy(CY)).toHaveLength(0);

  // The answer is in the room once, and the bot's own message did not come back as a second post.
  expect(posts().filter((post) => post.authorKind === "agent")).toHaveLength(1);
  expect(fake.deliveryErrors).toEqual([]);
});

test("a reply in the Slack thread joins the topic, a guest posts as a named guest and wakes nobody, a mention wakes that agent", async () => {
  await link();
  const first = fake.say({
    channel: CHANNEL,
    text: "Kickoff: plan the launch",
    user: DOM_SLACK,
  });
  await settle();
  const runsAfterKickoff = runs().length;

  fake.say({
    channel: CHANNEL,
    text: "Also check the budget.",
    threadTs: first.ts,
    user: DOM_SLACK,
  });
  fake.say({
    channel: CHANNEL,
    text: "Can I join the launch?",
    threadTs: first.ts,
    user: GUEST_SLACK,
  });
  await settle();

  expect(topics()).toHaveLength(1);
  const guestPost = posts().find((post) => post.authorId.startsWith("slack:"));
  expect(guestPost).toMatchObject({
    authorId: `slack:${SLACK_TEAM}:${GUEST_SLACK}`,
    authorKind: "user",
    text: `${GUEST_NAME} (Slack guest): Can I join the launch?`,
  });
  // Dom's reply woke the lead once more. The guest's post woke nobody.
  expect(runs().length).toBe(runsAfterKickoff + 1);
  // The guest has no Agentum account, so they were told once how to get linked.
  expect(fake.ephemerals).toMatchObject([
    { channel: CHANNEL, user: GUEST_SLACK },
  ]);

  fake.say({
    channel: CHANNEL,
    text: `<@${CY.botUserId}> what do you think?`,
    threadTs: first.ts,
    user: DOM_SLACK,
  });
  await settle();

  expect(
    runs().filter((run) => run.agentId === agentIds.get("Cy"))
  ).toHaveLength(1);
  const cyAnswers = slackPostsBy(CY);
  expect(cyAnswers).toHaveLength(1);
  expect(cyAnswers[0]).toMatchObject({ threadTs: first.ts });
  expect(fake.deliveryErrors).toEqual([]);
});

test("room to Slack: a person's post goes out through the lead's app with their name, and an app that left the channel falls back to the lead's", async () => {
  await link();
  inviteDi();
  const first = fake.say({
    channel: CHANNEL,
    text: "Kickoff: plan the launch",
    user: DOM_SLACK,
  });
  await settle();
  const [topic] = topics();
  if (!topic) {
    throw new Error("no topic");
  }

  // Dom types in Agentum. Nobody is named and the lead listens, so Ada answers.
  await composed.services.inbox.post(dom, {
    text: "Please send the draft.",
    threadId: topic.id,
  });
  await settle();

  const lead = slackPostsBy(ADA);
  expect(
    lead.some((message) =>
      message.text.startsWith("*Dom Fretz:* Please send the draft.")
    )
  ).toBe(true);
  expect(lead.every((message) => message.threadTs === first.ts)).toBe(true);
  // The person's own post did not come back as a second room post.
  expect(
    posts().filter((post) => post.text === "Please send the draft.")
  ).toHaveLength(1);

  // Di's app leaves the channel. Its next post goes out through the lead's app, with Di's name.
  removeDi();
  await composed.services.inbox.post(dom, {
    text: "@di please review.",
    threadId: topic.id,
  });
  await settle();

  expect(slackPostsBy(DI)).toHaveLength(0);
  expect(
    slackPostsBy(ADA).some((message) => message.text.startsWith("*Di:*"))
  ).toBe(true);
  expect(fake.deliveryErrors).toEqual([]);
});

/** Links the room, runs Ada from it, and opens an approval whose card lands in the Slack thread. */
const openRoomApproval = async () => {
  await link();
  const first = fake.say({
    channel: CHANNEL,
    text: "Kickoff: plan the launch",
    user: DOM_SLACK,
  });
  await settle();
  const [topic] = topics();
  if (!topic) {
    throw new Error("no topic");
  }

  // A run of Ada's, asked from the room, that needs an approval.
  const adaId = agentIds.get("Ada") as string;
  const started = await composed.services.runs.startRun(
    dom,
    {
      agentId: adaId,
      input: { text: "Send the launch email." },
      reply: { kind: "inbox", threadId: topic.id },
      session: { origin: "ui" },
    },
    { offerLater: true }
  );
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, started.runId);
  const runPrincipal: Principal = {
    agentId: adaId,
    kind: "run",
    runId: started.runId,
    workspaceId,
  };
  const request = await composed.services.requests.open(runPrincipal, {
    input: { to: "team@example.test" },
    kind: "approval",
    runId: started.runId,
    toolName: "send_email",
    toolUseId: "tool-1",
  });
  await settle();

  const card = slackPostsBy(ADA).find((message) => message.blocks !== null);
  return { adaId, card, first, request };
};

test("a request card of a room run goes into the Slack thread, and a click on it answers the request", async () => {
  const { card, first, request } = await openRoomApproval();
  expect(card).toMatchObject({ channel: CHANNEL, threadTs: first.ts });
  expect(JSON.stringify(card?.blocks)).toContain(
    `ag_req:${request.id}:allow_once`
  );

  fake.click({
    actionId: `ag_req:${request.id}:allow_once`,
    channel: CHANNEL,
    ts: card?.ts ?? "",
    user: DOM_SLACK,
  });
  await settle();

  const [row] = db
    .select()
    .from(runRequests)
    .where(eq(runRequests.id, request.id))
    .all();
  expect(row).toMatchObject({ answeredVia: "slack", status: "answered" });
  // The card settled in Slack.
  expect(JSON.stringify(card?.blocks)).not.toContain('"type":"actions"');
  expect(fake.deliveryErrors).toEqual([]);
});

test("a linked member who does not own the agent presses Always allow on a room card: a private refusal, no rule, and the card stays open", async () => {
  const { adaId, card, request } = await openRoomApproval();

  fake.click({
    actionId: `ag_req:${request.id}:always_allow`,
    channel: CHANNEL,
    ts: card?.ts ?? "",
    user: DOM_SLACK,
  });
  await settle();

  expect(fake.ephemerals).toMatchObject([
    {
      channel: CHANNEL,
      text: "Only the agent's owner can always allow this. Allow it once instead.",
      user: DOM_SLACK,
    },
  ]);
  const [row] = db
    .select()
    .from(runRequests)
    .where(eq(runRequests.id, request.id))
    .all();
  expect(row?.status).toBe("pending");
  expect(
    await composed.services.requests.listRules(owner, { agentId: adaId })
  ).toEqual([]);
  expect(JSON.stringify(card?.blocks)).toContain('"type":"actions"');
  expect(fake.deliveryErrors).toEqual([]);
});

test("slack_history and slack_search both find the room's messages", async () => {
  await link();
  fake.say({
    channel: CHANNEL,
    text: "Kickoff: plan the launch",
    user: DOM_SLACK,
  });
  fake.say({
    channel: CHANNEL,
    text: "Budget needs a number by Monday",
    user: GUEST_SLACK,
  });
  await settle();

  const adaId = agentIds.get("Ada") as string;
  const started = await composed.services.runs.startRun(
    dom,
    { agentId: adaId, input: { text: "x" }, session: { origin: "mcp" } },
    { offerLater: true }
  );
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, started.runId);
  const run: Principal = {
    agentId: adaId,
    kind: "run",
    runId: started.runId,
    workspaceId,
  };
  const history = await composed.services.slackHistory.history(run, {
    channel: "sl5-room",
  });
  expect(history.messages.map((message) => message.text)).toEqual(
    expect.arrayContaining([
      "Kickoff: plan the launch",
      "Budget needs a number by Monday",
    ])
  );

  const found = await composed.services.slackHistory.search(run, {
    query: "budget",
  });
  expect(found.hits.map((hit) => hit.text)).toEqual([
    "Budget needs a number by Monday",
  ]);
  expect(fake.deliveryErrors).toEqual([]);
});

test("a channel that is not linked keeps its old path: a mention starts the agent's own Slack run and the room records nothing", async () => {
  const mention = fake.say({
    channel: CHANNEL,
    text: `<@${ADA.botUserId}> hello there`,
    user: DOM_SLACK,
  });
  await settle();

  expect(topics()).toHaveLength(0);
  expect(posts()).toHaveLength(0);
  expect(db.select().from(slackRoomMessages).all()).toHaveLength(0);
  // The per-agent path ran: Ada has one run, answered in the thread of the mention.
  expect(
    runs().filter((run) => run.agentId === agentIds.get("Ada"))
  ).toHaveLength(1);
  expect(slackPostsBy(ADA).at(0)).toMatchObject({ threadTs: mention.ts });
  expect(fake.deliveryErrors).toEqual([]);
});

/** A signed message event from `app`, naming Dom, as Slack's servers would send it. */
const deliverAs = async (app: FakeSlackApp, text: string, ts: string) => {
  const body = JSON.stringify({
    api_app_id: app.appId,
    event: {
      channel: CHANNEL,
      channel_type: "channel",
      text,
      ts,
      type: "message",
      user: DOM_SLACK,
    },
    event_id: `Ev0${ts}`,
    event_time: Math.floor(Date.now() / 1000),
    team_id: SLACK_TEAM,
    type: "event_callback",
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  await deliver({
    appId: app.appId,
    kind: "events",
    rawBody: body,
    signature: await signSlackBody({
      body,
      signingSecret: app.signingSecret,
      timestamp,
    }),
    timestamp,
  });
  await settle();
};

test("a linked channel hears only the team's own apps: an app whose agent is not on the team writes nothing and wakes nobody", async () => {
  await link();
  const outsider = appOf("evil", "Evil");
  const evil = await composed.services.agents.create(
    { kind: "user", userId: "user_mallory", via: "session", workspaceId },
    { model: "fake", name: outsider.name, runtime: "fake" }
  );
  await installApp(evil.id, outsider);

  await deliverAs(
    outsider,
    `<@${ADA.botUserId}> wire the money`,
    "1790000000.000100"
  );

  expect(posts()).toHaveLength(0);
  expect(topics()).toHaveLength(0);
  expect(db.select().from(slackRoomMessages).all()).toHaveLength(0);
  expect(db.select().from(slackMessages).all()).toHaveLength(0);
  expect(runs()).toHaveLength(0);
});

test("a linked channel hears a member app: the same event records one post and wakes the lead", async () => {
  await link();

  await deliverAs(CY, "Plan the launch", "1790000000.000200");

  expect(posts().filter((post) => post.authorKind === "user")).toMatchObject([
    { authorId: DOM },
  ]);
  expect(
    db
      .select()
      .from(slackRoomMessages)
      .all()
      .filter((row) => row.direction === "in")
  ).toHaveLength(1);
  expect(
    runs().filter((run) => run.agentId === agentIds.get("Ada"))
  ).toHaveLength(1);
});
