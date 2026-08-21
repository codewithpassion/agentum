import { Database, type SQLQueryBindings } from "bun:sqlite";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Db } from "#/db/client";

/**
 * The per-app events endpoint, end to end: two connected agents, each with its
 * own signing secret, against the shipped migrations in an in-memory database
 * and a faked Slack API.
 *
 * What it pins down: a signature is only ever checked against the app the URL
 * names, a draft may answer the handshake and nothing else, an event is only
 * acted on by the app that owns the bridge, and a reply goes back out through
 * that app's own bot token.
 */

// `publishMessage` reaches the channel and router Durable Objects, which import
// a module only the Workers runtime provides.
mock.module("cloudflare:workers", () => ({ DurableObject: class {} }));

const { generateConnectorKey } = await import("#/crypto");
const { createDb } = await import("#/db/client");
const { createAgent } = await import("#/modules/agents/service");
const { publishMessage } = await import("#/modules/messaging/publish");
const { createChannel, listChannelMembers, listChannelMessages, listChannels } =
  await import("#/modules/messaging/service");
const {
  answerQuestion,
  ask,
  expireQuestion,
  getQuestion: readQuestion,
} = await import("#/modules/questions/service");
const { createWorkspace } = await import("#/modules/workspaces/service");
const { findBridgeByExternalChannel, upsertBridge } = await import(
  "../bridges"
);
const { claimSlackKey } = await import("../events-seen");
const { findExternalId } = await import("../refs");
const { slackUsers } = await import("../schema");
const { createDraftSlackApp, storeSlackAppTokens } = await import("./apps");
const { encodeQuestionAction } = await import("./blocks");
const { slackRoutes } = await import("./routes");
const { signSlackRequest } = await import("./signature");

const KEY = generateConnectorKey();
const MILLISECONDS = 1000;
const ADA_CHANNEL = "C0ADACHAN";
const ADA_TOKEN = "xoxb-ada-token";
const ADA_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BOB_TOKEN = "xoxb-bob-token";
const BOB_SECRET = "0000000000000000000000000000bbbb";
/** A Slack channel nothing is bridged to - what an invite arrives from. */
const NEW_CHANNEL = "C0NEWCHAN";

const migrationsDir = new URL("../../../../drizzle/", import.meta.url);

const createTestD1 = (): D1Database => {
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", migrationsDir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  for (const entry of journal.entries) {
    const sql = readFileSync(
      new URL(`${entry.tag}.sql`, migrationsDir),
      "utf8"
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.exec(statement);
    }
  }

  return {
    batch: (statements: { all: () => Promise<unknown> }[]) =>
      Promise.all(statements.map((statement) => statement.all())),
    prepare: (query: string) => {
      const stmt = sqlite.query(query);
      return {
        bind: (...params: SQLQueryBindings[]) => ({
          all: () => Promise.resolve({ results: stmt.all(...params) }),
          raw: () => Promise.resolve(stmt.values(...params)),
          run: () => Promise.resolve(stmt.run(...params)),
        }),
      };
    },
  } as unknown as D1Database;
};

interface SlackCall {
  method: string;
  payload: Record<string, unknown>;
  token: string;
  url: string;
}

let slackCalls: SlackCall[];
let postedTs: number;

/** Where a button click's `response_url` points in these tests. */
const RESPONSE_URL = "https://hooks.slack.example/actions/T0RSL/1/abc";

/**
 * Slack's Web API, narrowed to what these paths touch. The bearer token is
 * recorded with every call: "which bot posted this" is the whole question the
 * mirror cases ask. `response_url` posts land here too - they are an ordinary
 * fetch to a URL Slack handed us, with no token at all.
 */
const fakeSlackFetch = ((
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const url = String(typeof input === "string" ? input : input.toString());
  const method = url.split("/api/")[1]?.split("?")[0] ?? "";
  const headers = new Headers(init?.headers);
  const body =
    typeof init?.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
  slackCalls.push({
    method,
    payload: body,
    token: (headers.get("authorization") ?? "").replace("Bearer ", ""),
    url,
  });

  postedTs += 1;
  const answers: Record<string, unknown> = {
    "auth.test": {
      ok: true,
      team: "Rocky Shores",
      team_id: "T0RSL",
      user_id: "U0BOT",
    },
    // A distinct `ts` per post, as Slack gives: the question card's own `ts` is
    // what a later `chat.update` has to find.
    "chat.postMessage": { ok: true, ts: `1787200000.0009${postedTs}` },
    "conversations.info": {
      channel: { id: NEW_CHANNEL, is_member: true, name: "ops-standup" },
      ok: true,
    },
    "users.info": {
      ok: true,
      user: { profile: { display_name: "Ada Lovelace" } },
    },
  };
  return Promise.resolve(Response.json(answers[method] ?? { ok: true }));
}) as unknown as typeof fetch;

const callsTo = (method: string): SlackCall[] =>
  slackCalls.filter((call) => call.method === method);

const responseCalls = (): SlackCall[] =>
  slackCalls.filter((call) => call.url === RESPONSE_URL);

/** The first call of a kind, or `undefined` when there was none. */
const callTo = (method: string): SlackCall | undefined => callsTo(method)[0];

/** Its body, or an empty one - so an assertion reads as a missing field. */
const payloadOf = (call: SlackCall | undefined): Record<string, unknown> =>
  call ? call.payload : {};

const responseCall = (): SlackCall | undefined => responseCalls()[0];

let d1: D1Database;
let db: Db;
let env: Env;
let pending: Promise<unknown>[];
let woken: { body: string }[];
let workspace: { id: string; slug: string };
let memberId: string;
let adaId: string;
let bobId: string;
let adaAppId: string;
let bobAppId: string;
let draftAppId: string;
let channelId: string;

const executionCtx = {
  passThroughOnException: () => {
    // Nothing to pass through: the fake environment has no origin behind it.
  },
  waitUntil: (promise: Promise<unknown>) => {
    pending.push(promise);
  },
} as unknown as ExecutionContext;

const settle = async () => {
  await Promise.all(pending);
  pending = [];
};

interface PostOptions {
  signWith?: string | null;
  timestamp?: string;
}

const send = async (
  path: string,
  rawBody: string,
  contentType: string,
  options: PostOptions
): Promise<Response> => {
  const timestamp =
    options.timestamp ?? String(Math.floor(Date.now() / MILLISECONDS));
  const secret = options.signWith === undefined ? ADA_SECRET : options.signWith;

  return await slackRoutes.request(
    path,
    {
      body: rawBody,
      headers: {
        "content-type": contentType,
        ...(secret
          ? {
              "x-slack-request-timestamp": timestamp,
              "x-slack-signature": await signSlackRequest(
                secret,
                timestamp,
                rawBody
              ),
            }
          : {}),
      },
      method: "POST",
    },
    env,
    executionCtx
  );
};

const post = (
  appId: string,
  body: unknown,
  options: PostOptions = {}
): Promise<Response> =>
  send(`/${appId}`, JSON.stringify(body), "application/json", options);

/** An interaction is form-encoded with the JSON in a single `payload` field. */
const postInteractive = (
  appId: string,
  payload: unknown,
  options: PostOptions = {}
): Promise<Response> =>
  send(
    `/${appId}/interactive`,
    new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
    "application/x-www-form-urlencoded",
    options
  );

const blockActions = (action: Record<string, unknown>, user = "U1HUMAN") => ({
  actions: [action],
  channel: { id: ADA_CHANNEL },
  response_url: RESPONSE_URL,
  type: "block_actions",
  user: { id: user },
});

const optionClick = (questionId: string, option: string, user = "U1HUMAN") =>
  blockActions(
    {
      action_id: `question:${questionId}:0`,
      value: encodeQuestionAction({ option, questionId }),
    },
    user
  );

const messageEvent = (channel: string, ts: string, text = "hello there") => ({
  authorizations: [{ user_id: "U0BOT" }],
  event: { channel, text, ts, type: "message", user: "U1HUMAN" },
  event_id: `Ev${ts}`,
  team_id: "T0RSL",
  type: "event_callback",
});

const channelMessages = async () =>
  (
    await listChannelMessages(db, workspace, {
      channelId,
      limit: 50,
    })
  ).messages;

const connect = async (
  agentId: string,
  token: string,
  signingSecret: string
): Promise<string> => {
  const draft = await createDraftSlackApp(db, workspace.id, agentId);
  const result = await storeSlackAppTokens(
    db,
    KEY,
    draft,
    { botToken: token, signingSecret },
    fakeSlackFetch
  );
  return result.app.id;
};

/** The question card the Slack cases press buttons on. */
const askInChannel = async (
  options: string[] | null = ["Friday", "Monday"]
) => {
  const result = await ask(
    db,
    env,
    workspace,
    { id: adaId, name: "Ada" },
    { channelId, options, prompt: "Ship it on Friday or Monday?" }
  );
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.question;
};

const broadcasts: { question?: { status: string }; type: string }[] = [];

beforeEach(async () => {
  slackCalls = [];
  pending = [];
  postedTs = 0;
  woken = [];
  broadcasts.length = 0;
  globalThis.fetch = fakeSlackFetch;

  d1 = createTestD1();
  db = createDb(d1);
  env = {
    AGENT_ROUTER: {
      get: () => ({
        notifyMessage: (notification: { body: string }) => {
          woken.push(notification);
          return Promise.resolve();
        },
      }),
      idFromName: (name: string) => name,
    },
    CHANNEL_ROOM: {
      get: () => ({
        broadcast: (payload: string) => {
          broadcasts.push(
            JSON.parse(payload) as {
              question?: { status: string };
              type: string;
            }
          );
          return Promise.resolve();
        },
      }),
      idFromName: (name: string) => name,
    },
    CONNECTOR_KEY: KEY,
    DB: d1,
    PUBLIC_APP_URL: "https://agentum.example.com",
  } as unknown as Env;

  const created = await createWorkspace(db, {
    name: "Alpha",
    owner: {
      clerkUserId: "user_ada",
      email: "ada@example.com",
      imageUrl: null,
      name: "Ada",
    },
  });
  workspace = { id: created.workspace.id, slug: created.workspace.slug };
  memberId = created.member.id;

  const ada = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Ada",
    soul: "",
  });
  adaId = ada.agent.id;
  const bob = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Bob",
    soul: "",
  });
  bobId = bob.agent.id;
  const carol = await createAgent(db, workspace.id, {
    instructions: "",
    name: "Carol",
    soul: "",
  });

  adaAppId = await connect(adaId, ADA_TOKEN, ADA_SECRET);
  bobAppId = await connect(bobId, BOB_TOKEN, BOB_SECRET);
  draftAppId = (await createDraftSlackApp(db, workspace.id, carol.agent.id)).id;

  const channel = await createChannel(db, workspace.id, { name: "ops" });
  channelId = channel.id;
  await upsertBridge(db, workspace.id, {
    agentId: adaId,
    channelId,
    connector: "slack",
    externalChannelId: ADA_CHANNEL,
    slackAppId: adaAppId,
  });
  slackCalls = [];
});

const joinEvent = (channel: string, user: string, eventId = "Ev0JOIN") => ({
  authorizations: [{ user_id: "U0BOT" }],
  event: { channel, channel_type: "C", type: "member_joined_channel", user },
  event_id: eventId,
  team_id: "T0RSL",
  type: "event_callback",
});

/** The Slack mention of a message, which arrives beside its `message` twin. */
const mentionEvent = (channel: string, ts: string) => ({
  ...messageEvent(channel, ts, "<@U0BOT> hello there"),
  event: {
    channel,
    text: "<@U0BOT> hello there",
    ts,
    type: "app_mention",
    user: "U1HUMAN",
  },
  event_id: `Ev${ts}mention`,
});

describe("being invited to a Slack channel", () => {
  const bridgeFor = async (externalChannelId: string) =>
    await findBridgeByExternalChannel(db, "slack", externalChannelId);

  test("makes the channel, the membership and the bridge", async () => {
    const response = await post(adaAppId, joinEvent(NEW_CHANNEL, "U0BOT"));
    await settle();

    expect(response.status).toBe(200);
    const bridge = await bridgeFor(NEW_CHANNEL);
    expect(bridge?.agentId).toBe(adaId);

    const channels = await listChannels(db, workspace.id);
    const made = channels.find((row) => row.name === "ops-standup");
    expect(made?.origin).toBe("slack");
    expect(bridge?.channelId).toBe(made?.id);

    // Without the agent in it a mention would be ingested and wake nobody -
    // the failure this whole path exists to stop.
    const members = await listChannelMembers(db, workspace.id, made?.id ?? "");
    expect(
      members.some(
        (member) => member.memberType === "agent" && member.memberId === adaId
      )
    ).toBe(true);
  });

  test("a message in the new channel now reaches the workspace", async () => {
    await post(adaAppId, joinEvent(NEW_CHANNEL, "U0BOT"));
    await settle();

    await post(adaAppId, messageEvent(NEW_CHANNEL, "1787200000.000700"));
    await settle();

    const bridge = await bridgeFor(NEW_CHANNEL);
    const { messages } = await listChannelMessages(db, workspace, {
      channelId: bridge?.channelId ?? "",
      limit: 50,
    });
    expect(messages.map((message) => message.body)).toEqual(["hello there"]);
  });

  test("somebody else joining is not an invitation", async () => {
    await post(adaAppId, joinEvent(NEW_CHANNEL, "U1HUMAN"));
    await settle();

    expect(await bridgeFor(NEW_CHANNEL)).toBeUndefined();
  });

  test("a re-invite leaves the channel it already made alone", async () => {
    await post(adaAppId, joinEvent(NEW_CHANNEL, "U0BOT", "Ev0JOIN1"));
    await settle();
    const first = await bridgeFor(NEW_CHANNEL);

    await post(adaAppId, joinEvent(NEW_CHANNEL, "U0BOT", "Ev0JOIN2"));
    await settle();

    // A second channel here would strand the conversation in the first one.
    expect((await bridgeFor(NEW_CHANNEL))?.channelId).toBe(
      first?.channelId ?? ""
    );
    expect(
      (await listChannels(db, workspace.id)).filter(
        (row) => row.name === "ops-standup"
      )
    ).toHaveLength(1);
  });
});

describe("a mention, delivered twice", () => {
  test("is published once", async () => {
    const ts = "1787200000.000600";

    // Slack sends both, under different delivery ids, and in production they
    // land in two Worker invocations that cannot see each other.
    await post(adaAppId, messageEvent(ADA_CHANNEL, ts, "<@U0BOT> hello there"));
    await post(adaAppId, mentionEvent(ADA_CHANNEL, ts));
    await settle();

    expect(await channelMessages()).toHaveLength(1);
  });

  test("leaves no message without a Slack ts to thread back to", async () => {
    const ts = "1787200000.000601";

    await post(adaAppId, messageEvent(ADA_CHANNEL, ts, "<@U0BOT> hello there"));
    await post(adaAppId, mentionEvent(ADA_CHANNEL, ts));
    await settle();

    const [message] = await channelMessages();
    expect(
      await findExternalId(db, "slack", "message", message?.id ?? "")
    ).toBe(`${ADA_CHANNEL}:${ts}`);
  });

  test("claims the message itself, not just the two deliveries", async () => {
    const ts = "1787200000.000602";

    await post(adaAppId, messageEvent(ADA_CHANNEL, ts, "<@U0BOT> hello there"));
    await settle();

    // The claim, not the `external_refs` read, is what settles the race in
    // production: the two deliveries arrive in Worker invocations that cannot
    // see each other, and only an atomic insert separates them. Asserted
    // directly because a sequential test would pass on the fallback alone.
    expect(await claimSlackKey(db, `${ADA_CHANNEL}:${ts}`)).toBe(false);
  });
});

describe("the app the URL names", () => {
  test("an unknown id is refused, so a stale events URL fails loudly", async () => {
    const response = await post("00000000-0000-4000-8000-000000000000", {
      challenge: "3eZbrw1aB",
      type: "url_verification",
    });

    expect(response.status).toBe(404);
  });

  test("a signature made with another app's secret is invalid here", async () => {
    const response = await post(adaAppId, messageEvent(ADA_CHANNEL, "1.1"), {
      signWith: BOB_SECRET,
    });

    expect(response.status).toBe(401);
    expect(await channelMessages()).toHaveLength(0);
  });

  test("each app's own secret verifies against its own URL", async () => {
    const ada = await post(adaAppId, messageEvent(ADA_CHANNEL, "1.2"));
    const bob = await post(bobAppId, messageEvent("C0BOBCHAN", "1.3"), {
      signWith: BOB_SECRET,
    });

    expect([ada.status, bob.status]).toEqual([200, 200]);
  });

  test("refuses an unsigned and a replayed request", async () => {
    const unsigned = await post(adaAppId, messageEvent(ADA_CHANNEL, "1.4"), {
      signWith: null,
    });
    const stale = await post(adaAppId, messageEvent(ADA_CHANNEL, "1.5"), {
      timestamp: String(Math.floor(Date.now() / MILLISECONDS) - 60 * 10),
    });

    expect([unsigned.status, stale.status]).toEqual([401, 401]);
  });
});

describe("a draft app", () => {
  test("answers the url_verification handshake unsigned", async () => {
    // Slack verifies the request URL the moment the app is created from the
    // manifest - before anyone could have pasted us a signing secret.
    const response = await post(
      draftAppId,
      { challenge: "3eZbrw1aB", type: "url_verification" },
      { signWith: null }
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(await response.text())).toEqual({
      challenge: "3eZbrw1aB",
    });
  });

  test("refuses every other event while it has no secret", async () => {
    const response = await post(draftAppId, messageEvent(ADA_CHANNEL, "1.6"), {
      signWith: null,
    });

    expect(response.status).toBe(401);
    expect(await channelMessages()).toHaveLength(0);
  });
});

describe("the ownership filter", () => {
  test("an event for an app that does not own the bridge is dropped", async () => {
    // Both bots sit in `ADA_CHANNEL`, so both are delivered its messages. Only
    // the one the bridge belongs to may act on it.
    const response = await post(bobAppId, messageEvent(ADA_CHANNEL, "1.7"), {
      signWith: BOB_SECRET,
    });
    await settle();

    expect(response.status).toBe(200);
    expect(await channelMessages()).toHaveLength(0);
  });
});

describe("a verified event, end to end", () => {
  test("is ingested, and the reply goes out through that app's own bot", async () => {
    const response = await post(adaAppId, messageEvent(ADA_CHANNEL, "1.8"));
    await settle();

    expect(response.status).toBe(200);
    const ingested = await channelMessages();
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.body).toBe("hello there");
    expect(ingested[0]?.origin).toBe("slack");

    // The agent this app speaks as posts as the bot itself: no name prefix,
    // because in Slack the bot *is* Ada.
    await publishMessage(db, env, {
      attachmentIds: [],
      authorId: adaId,
      authorType: "agent",
      body: "on it",
      channelId,
      workspace,
    });
    // Anyone else sharing the channel keeps theirs.
    await publishMessage(db, env, {
      attachmentIds: [],
      authorId: bobId,
      authorType: "agent",
      body: "me too",
      channelId,
      workspace,
    });

    const posts = slackCalls.filter(
      (call) => call.method === "chat.postMessage"
    );
    expect(posts).toHaveLength(2);
    expect(posts[0]).toMatchObject({
      payload: { channel: ADA_CHANNEL, text: "on it" },
      token: ADA_TOKEN,
    });
    expect(posts[1]).toMatchObject({
      payload: { channel: ADA_CHANNEL, text: "*Bob*\nme too" },
      token: ADA_TOKEN,
    });
  });

  test("a message from Slack is never mirrored back to Slack", async () => {
    await post(adaAppId, messageEvent(ADA_CHANNEL, "1.9"));
    await settle();

    expect(callsTo("chat.postMessage")).toHaveLength(0);
  });
});

describe("a question card in Slack", () => {
  test("is mirrored as blocks, with a button per option", async () => {
    await askInChannel();

    expect(callTo("chat.postMessage")?.token).toBe(ADA_TOKEN);
    expect(payloadOf(callTo("chat.postMessage")).text).toBe(
      "Ship it on Friday or Monday?"
    );
    const blocks = payloadOf(callTo("chat.postMessage")).blocks as {
      type: string;
    }[];
    expect(blocks.map((block) => block.type)).toEqual(["section", "actions"]);
  });
});

describe("the interactive endpoint", () => {
  test("refuses an unsigned click, and one signed with another app's secret", async () => {
    const question = await askInChannel();

    const unsigned = await postInteractive(
      adaAppId,
      optionClick(question.id, "Friday"),
      { signWith: null }
    );
    const wrongSecret = await postInteractive(
      adaAppId,
      optionClick(question.id, "Friday"),
      { signWith: BOB_SECRET }
    );
    await settle();

    expect([unsigned.status, wrongSecret.status]).toEqual([401, 401]);
    expect((await readQuestion(db, workspace.id, question.id))?.status).toBe(
      "pending"
    );
  });

  test("refuses a draft app, which has no handshake to hide behind", async () => {
    const question = await askInChannel();

    const response = await postInteractive(
      draftAppId,
      optionClick(question.id, "Friday"),
      { signWith: null }
    );

    expect(response.status).toBe(401);
    expect((await readQuestion(db, workspace.id, question.id))?.status).toBe(
      "pending"
    );
  });

  test("drops a click that arrives for an app which does not own the bridge", async () => {
    // Bob's bot sits in the same Slack channel and sees the same card. The
    // question belongs to the bridge Ada's app owns, so Bob's click does nothing
    // - and is still acked, because Slack retries anything else.
    const question = await askInChannel();
    slackCalls = [];

    const response = await postInteractive(
      bobAppId,
      optionClick(question.id, "Friday"),
      { signWith: BOB_SECRET }
    );
    await settle();

    expect(response.status).toBe(200);
    expect((await readQuestion(db, workspace.id, question.id))?.status).toBe(
      "pending"
    );
    expect(responseCalls()).toHaveLength(0);
  });

  test("answers the question, attributed to the Slack user who clicked", async () => {
    const question = await askInChannel();
    slackCalls = [];
    broadcasts.length = 0;

    const response = await postInteractive(
      adaAppId,
      optionClick(question.id, "Friday")
    );
    await settle();

    expect(response.status).toBe(200);
    const answered = await readQuestion(db, workspace.id, question.id);
    expect(answered).toMatchObject({
      answer: "Friday",
      answeredBy: "slack:U1HUMAN",
      answeredVia: "slack",
      status: "answered",
    });

    // The name behind `U1HUMAN` is cached on the way past, so every later view
    // of this answer reads "Ada Lovelace" without a Slack round trip.
    const [cached] = await db.select().from(slackUsers);
    expect(cached?.displayName).toBe("Ada Lovelace");

    // The web card redraws from the same broadcast a web answer emits.
    expect(
      broadcasts.filter(
        (event) =>
          event.type === "question.updated" &&
          event.question?.status === "answered"
      )
    ).toHaveLength(1);

    // And the agent is woken by the answer reply, exactly as a mention wakes it.
    expect(woken.some((wake) => wake.body.includes("Answer: Friday"))).toBe(
      true
    );

    // The card the button sat in is replaced through `response_url`.

    expect(payloadOf(responseCall()).replace_original).toBe(true);
    expect(JSON.stringify(payloadOf(responseCall()).blocks)).toContain(
      "Answered by Ada Lovelace"
    );
    // No `chat.update` chasing it: the card has already been rewritten.
    expect(callsTo("chat.update")).toHaveLength(0);
  });

  test("shows the web answerer when a click loses the race", async () => {
    const question = await askInChannel();
    await answerQuestion(db, env, workspace, question, {
      answer: "Monday",
      by: {
        authorId: "user_ada",
        authorType: "user",
        id: memberId,
        via: "web",
      },
    });
    slackCalls = [];

    const response = await postInteractive(
      adaAppId,
      optionClick(question.id, "Friday")
    );
    await settle();

    expect(response.status).toBe(200);
    // First answer wins: the row still says what the web card said.
    expect(await readQuestion(db, workspace.id, question.id)).toMatchObject({
      answer: "Monday",
      answeredVia: "web",
    });

    expect(payloadOf(responseCall()).replace_original).toBe(true);
    expect(JSON.stringify(payloadOf(responseCall()).blocks)).toContain(
      "Answered by Ada"
    );
    expect(JSON.stringify(payloadOf(responseCall()).blocks)).toContain(
      "Monday"
    );
  });

  test("acks a click that carries no answer, such as the link button", async () => {
    // A URL button reports its click too. There is nothing to answer with, and
    // nothing to say back.
    await askInChannel();
    slackCalls = [];

    const response = await postInteractive(
      adaAppId,
      blockActions({ action_id: "question:open", url: "https://example.com" })
    );
    await settle();

    expect(response.status).toBe(200);
    expect(responseCalls()).toHaveLength(0);
  });

  test("acks an interaction type it does not handle", async () => {
    const response = await postInteractive(adaAppId, {
      type: "view_submission",
    });
    await settle();

    expect(response.status).toBe(200);
    expect(responseCalls()).toHaveLength(0);
  });
});

describe("a resolution that happened elsewhere", () => {
  test("rewrites the mirrored card when the web answers", async () => {
    const question = await askInChannel();
    // The card's own `channel:ts`, recorded when it was mirrored.
    const cardKey = await findExternalId(
      db,
      "slack",
      "message",
      question.messageId
    );
    slackCalls = [];

    await answerQuestion(db, env, workspace, question, {
      answer: "Monday",
      by: {
        authorId: "user_ada",
        authorType: "user",
        id: memberId,
        via: "web",
      },
    });

    expect(callTo("chat.update")?.token).toBe(ADA_TOKEN);
    expect(payloadOf(callTo("chat.update")).channel).toBe(ADA_CHANNEL);
    // The card the question was posted as, not the answer reply beneath it.
    expect(`${ADA_CHANNEL}:${payloadOf(callTo("chat.update")).ts}`).toBe(
      cardKey ?? ""
    );
    expect(JSON.stringify(payloadOf(callTo("chat.update")).blocks)).toContain(
      "Answered by Ada"
    );
  });

  test("rewrites the mirrored card when the question expires", async () => {
    const question = await askInChannel();
    slackCalls = [];

    await expireQuestion(db, env, workspace, question);

    expect(JSON.stringify(payloadOf(callTo("chat.update")).blocks)).toContain(
      "Expired"
    );
  });
});
