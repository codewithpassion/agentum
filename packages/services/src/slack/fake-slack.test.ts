import { expect, test } from "bun:test";
import {
  createFakeSlack,
  type Delivery,
  type FakeSlackApp,
} from "./fake-slack.ts";
import { verifySlackRequest } from "./signature.ts";

const TEAM = "T0FAKE";
const CHANNEL = "C0FAKE";
const PERSON = "U0PERSON";

const appOf = (slug: string): FakeSlackApp => ({
  appId: `A0${slug}`,
  botId: `B0${slug}`,
  botUserId: `U0${slug}BOT`,
  name: slug,
  signingSecret: `secret-${slug}`,
  token: `xoxb-${slug}`,
});
const ONE = appOf("ONE");
const TWO = appOf("TWO");
const OUT = appOf("OUT");

const setup = () => {
  const delivered: Delivery[] = [];
  const fake = createFakeSlack({
    config: {
      apps: [ONE, TWO, OUT],
      channels: [
        {
          id: CHANNEL,
          isPrivate: false,
          members: [PERSON, ONE.botUserId, TWO.botUserId],
          name: "fake-room",
        },
      ],
      slackTeamId: TEAM,
      users: [{ email: null, id: PERSON, name: "Pat Person" }],
    },
    deliver: (delivery) => {
      delivered.push(delivery);
      return Promise.resolve();
    },
  });
  return { delivered, fake };
};

const call = async (
  fake: ReturnType<typeof setup>["fake"],
  app: FakeSlackApp,
  method: string,
  body: Record<string, unknown>
) => {
  const response = await fake.fetch(`https://slack.com/api/${method}`, {
    body: JSON.stringify(body),
    headers: { Authorization: `Bearer ${app.token}` },
    method: "POST",
  });
  return (await response.json()) as Record<string, unknown>;
};

test("a person's message is delivered once to each app in the channel, signed with that app's secret", async () => {
  const { delivered, fake } = setup();

  const message = fake.say({ channel: CHANNEL, text: "hello", user: PERSON });
  await fake.settled();

  expect(delivered.map((delivery) => delivery.appId).sort()).toEqual([
    ONE.appId,
    TWO.appId,
  ]);
  for (const delivery of delivered) {
    const app = delivery.appId === ONE.appId ? ONE : TWO;
    // biome-ignore lint/performance/noAwaitInLoops: two short checks, in order
    const genuine = await verifySlackRequest({
      body: delivery.rawBody,
      signature: delivery.signature,
      signingSecret: app.signingSecret,
      timestamp: delivery.timestamp,
    });
    expect(genuine).toBe(true);
    const payload = JSON.parse(delivery.rawBody) as {
      api_app_id: string;
      event: { channel_type: string; ts: string; type: string };
    };
    expect(payload.api_app_id).toBe(app.appId);
    expect(payload.event).toMatchObject({ ts: message.ts, type: "message" });
  }
});

test("a mention adds an app_mention for the app named, and an app's own post reaches every app marked as a bot", async () => {
  const { delivered, fake } = setup();

  fake.say({
    channel: CHANNEL,
    text: `<@${TWO.botUserId}> are you there?`,
    user: PERSON,
  });
  await fake.settled();
  const types = delivered.map((delivery) => [
    delivery.appId,
    (JSON.parse(delivery.rawBody) as { event: { type: string } }).event.type,
  ]);
  expect(types).toContainEqual([TWO.appId, "app_mention"]);
  expect(types).not.toContainEqual([ONE.appId, "app_mention"]);

  delivered.length = 0;
  const posted = await call(fake, ONE, "chat.postMessage", {
    channel: CHANNEL,
    text: "I am here",
  });
  await fake.settled();
  expect(posted.ok).toBe(true);
  const events = delivered.map(
    (delivery) =>
      (JSON.parse(delivery.rawBody) as { event: Record<string, unknown> }).event
  );
  expect(events).toHaveLength(2);
  for (const event of events) {
    expect(event).toMatchObject({ bot_id: ONE.botId, user: ONE.botUserId });
  }
});

test("an app outside the channel cannot post, and history and replies come back in Slack's order", async () => {
  const { fake } = setup();

  expect(
    await call(fake, OUT, "chat.postMessage", { channel: CHANNEL, text: "x" })
  ).toMatchObject({ error: "not_in_channel", ok: false });

  const root = fake.say({ channel: CHANNEL, text: "root", user: PERSON });
  fake.say({
    channel: CHANNEL,
    text: "reply",
    threadTs: root.ts,
    user: PERSON,
  });
  fake.say({ channel: CHANNEL, text: "second", user: PERSON });

  const history = (await (
    await fake.fetch(
      `https://slack.com/api/conversations.history?channel=${CHANNEL}&limit=10`,
      { headers: { Authorization: `Bearer ${ONE.token}` } }
    )
  ).json()) as { messages: { text: string }[] };
  const texts = history.messages.map((m) => m.text);
  // Newest first, and the reply lives in the thread only.
  expect(texts).toEqual(["second", "root"]);

  const replies = (await (
    await fake.fetch(
      `https://slack.com/api/conversations.replies?channel=${CHANNEL}&ts=${root.ts}`,
      { headers: { Authorization: `Bearer ${ONE.token}` } }
    )
  ).json()) as { messages: { text: string }[] };
  expect(replies.messages.map((m) => m.text)).toEqual(["root", "reply"]);
});

test("a click on a card is delivered to the app that posted it, and chat.update changes the card", async () => {
  const { delivered, fake } = setup();
  const posted = await call(fake, ONE, "chat.postMessage", {
    blocks: [{ type: "actions" }],
    channel: CHANNEL,
    text: "card",
  });
  await fake.settled();
  delivered.length = 0;

  fake.click({
    actionId: "ag_req:r1:allow_once",
    channel: CHANNEL,
    ts: String(posted.ts),
    user: PERSON,
  });
  await fake.settled();

  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({
    appId: ONE.appId,
    kind: "interactions",
  });
  const payload = JSON.parse(
    new URLSearchParams(delivered[0]?.rawBody).get("payload") ?? "{}"
  ) as Record<string, unknown>;
  expect(payload).toMatchObject({
    api_app_id: ONE.appId,
    type: "block_actions",
  });

  await call(fake, ONE, "chat.update", {
    channel: CHANNEL,
    text: "settled",
    ts: posted.ts,
  });
  expect(fake.messages.at(-1)).toMatchObject({ blocks: null, text: "settled" });
});
