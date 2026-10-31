import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { slackApps } from "@repo/db/schema/slack";
import {
  identityLinks,
  workspaces as workspaceRows,
} from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import type { RequestOutcome } from "@repo/protocol/requests";
import { eq } from "drizzle-orm";
import { encryptSecret, importSecretsKey } from "../crypto.ts";
import { ServiceError } from "../errors.ts";
import type { EventRecord } from "../events.ts";
import type { RequestsService } from "../requests.ts";
import type { Clock, ReplyTarget } from "../runs/types.ts";
import type { Principal } from "../workspaces.ts";
import { slackSecretBinding } from "./apps.ts";
import type { SlackFetch } from "./client.ts";
import { createSlackRequests, type InteractResult } from "./requests.ts";
import { signSlackBody } from "./signature.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const AGENT = "a1";
const OTHER_AGENT = "a2";
const SESSION = "s1";
const RUN = "r1";
const REQUEST = "q1";
const START = "2026-10-16T10:00:00.000Z";
const EXPIRY_MS = 600_000;
const EXPIRES = new Date(Date.parse(START) + EXPIRY_MS).toISOString();
const MS_PER_SECOND = 1000;
const TEAM = "T0TEAM";
const CHANNEL = "C0CHAN";
const THREAD = "1700000000.000100";
const DM_CHANNEL = "D0DM";
const POSTED_TS = "1700000000.000200";
const TRIGGER = "trigger-1";
const APP_ID = "A0APP";
const APP_ROW = "sa1";
const BOT_TOKEN = "xoxb-test";
const SIGNING_SECRET = "signing-test";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const CLERK_USER = "u1";
/** The Slack id of the person linked to `CLERK_USER`. */
const LINKED_SLACK_ID = "U0DOMINIK";
/** A Slack user with no Harbourmaster link. */
const STRANGER_SLACK_ID = "U0STRANGER";
const CANT_ANSWER = "You can't answer this one.";
const BAD_SIGNATURE = `v0=${"0".repeat(64)}`;
const SLACK_API = "https://slack.com/api/";

const slackReply: ReplyTarget = {
  channel: CHANNEL,
  kind: "slack",
  teamId: TEAM,
  threadTs: THREAD,
};

const approvalDisplay = {
  input: { command: "ls" },
  summary: "Run ls",
  toolKey: "bash",
  toolName: "bash",
};

/** One request the fake Slack received. */
interface Recorded {
  authorization: string | null;
  body: Record<string, unknown> | null;
  method: string;
  url: string;
}

interface AnswerCall {
  input: { answer: unknown; requestId: string; via: string };
  principal: Principal;
}

type Responder = (call: Recorded) => Response;

let db: ReturnType<typeof migrated>;
let clock: Clock;
let calls: Recorded[];
let respond: Responder;
let answerCalls: AnswerCall[];
let cancelCalls: { principal: Principal; requestId: string }[];
let answerImpl: (call: AnswerCall) => Promise<void>;
let outcomeImpl: () => Promise<RequestOutcome | null>;
let gateway: ReturnType<typeof createSlackRequests>;

const json = (body: unknown): Response => Response.json(body);

/** Answers like Slack for the methods these tests use. */
const defaultResponder: Responder = (call) => {
  const method = call.url.replace(SLACK_API, "");
  if (method === "chat.postMessage") {
    return json({ ok: true, ts: POSTED_TS });
  }
  if (method === "chat.update" || method === "chat.postEphemeral") {
    return json({ ok: true });
  }
  if (method === "conversations.open") {
    return json({ channel: { id: DM_CHANNEL }, ok: true });
  }
  return json({ error: "unknown_method", ok: false });
};

const slackFetch: SlackFetch = (url, init) => {
  const headers = new Headers(init.headers);
  const body =
    typeof init.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : null;
  const call: Recorded = {
    authorization: headers.get("Authorization"),
    body,
    method: init.method ?? "GET",
    url,
  };
  calls.push(call);
  return Promise.resolve(respond(call));
};

/** The calls made to one Slack method, in order. */
const callsTo = (method: string) =>
  calls.filter((call) => call.url === `${SLACK_API}${method}`);

const field = (call: Recorded, key: string): string => String(call.body?.[key]);

const insertWorkspace = (id: string) =>
  db
    .insert(workspaceRows)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: START,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const insertAgent = (id: string, workspaceId: string) =>
  db
    .insert(agentRows)
    .values({
      createdAt: START,
      createdBy: CLERK_USER,
      id,
      instructions: "",
      model: "m",
      name: "Cloud",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: id,
      status: "active",
      workspaceId,
    })
    .run();

const insertSession = (id: string, agentId: string, workspaceId: string) =>
  db
    .insert(sessionRows)
    .values({
      actorId: CLERK_USER,
      actorKind: "user",
      agentId,
      createdAt: START,
      id,
      origin: "slack",
      workspaceId,
    })
    .run();

/** A run for `AGENT` in `WORKSPACE`, Slack-replied or web, optionally for a person. */
const seedRun = (
  reply: ReplyTarget | null,
  onBehalfOfUserId: string | null = CLERK_USER
) =>
  db
    .insert(runRows)
    .values({
      actorId: CLERK_USER,
      actorKind: "user",
      agentId: AGENT,
      createdAt: START,
      id: RUN,
      inputText: "hi",
      onBehalfOfUserId,
      reply: reply === null ? null : JSON.stringify(reply),
      sessionId: SESSION,
      status: "running",
      workspaceId: WORKSPACE,
    })
    .run();

type RequestSeed = Partial<typeof runRequests.$inferInsert>;

/** A pending approval for the seeded run. Pass `RequestSeed` fields to change it. */
const seedRequest = (overrides: RequestSeed = {}) =>
  db
    .insert(runRequests)
    .values({
      agentId: AGENT,
      createdAt: START,
      display: JSON.stringify(approvalDisplay),
      expiresAt: EXPIRES,
      id: REQUEST,
      kind: "approval",
      runId: RUN,
      sessionId: SESSION,
      status: "pending",
      toolKey: "bash",
      toolName: "bash",
      toolUseId: "tool-1",
      workspaceId: WORKSPACE,
      ...overrides,
    })
    .run();

const storedSlackMessage = JSON.stringify({
  appId: APP_ID,
  channel: CHANNEL,
  ts: POSTED_TS,
});

const readRequest = () =>
  db.select().from(runRequests).where(eq(runRequests.id, REQUEST)).get();

const linkSlackUser = (slackUserId: string, clerkUserId: string) =>
  db
    .insert(identityLinks)
    .values({
      clerkUserId,
      createdAt: START,
      email: "person@example.test",
      externalUserId: slackUserId,
      id: `link-${slackUserId}`,
      provider: "slack",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();

const eventOf = (
  type: EventRecord["type"],
  requestId: string
): EventRecord => ({
  actor: { id: "system", kind: "system" },
  agentId: AGENT,
  createdAt: START,
  id: `event-${type}`,
  payload: { requestId },
  payloadRef: null,
  runId: RUN,
  seq: 1,
  sessionId: SESSION,
  type,
  workspaceId: WORKSPACE,
});

/** Settles the seeded request in the row, as the requests service would. */
const settleRow = (values: {
  answer: string | null;
  answeredVia: "slack" | "web" | null;
  status: "answered" | "cancelled" | "expired";
}) =>
  db
    .update(runRequests)
    .set({
      answer: values.answer,
      answeredAt: values.answer === null ? null : START,
      answeredBy: values.answer === null ? null : CLERK_USER,
      answeredVia: values.answeredVia,
      status: values.status,
    })
    .where(eq(runRequests.id, REQUEST))
    .run();

const clickPayload = ({
  actionId = `hm_req:${REQUEST}:deny`,
  channel = CHANNEL,
  slackUserId = LINKED_SLACK_ID,
}: {
  actionId?: string;
  channel?: string;
  slackUserId?: string;
} = {}): Record<string, unknown> => ({
  actions: [{ action_id: actionId }],
  api_app_id: APP_ID,
  channel: { id: channel },
  team: { id: TEAM },
  trigger_id: TRIGGER,
  type: "block_actions",
  user: { id: slackUserId },
});

/** A signed interaction request, the body as Slack's form encoding sends it. */
const signedRequest = async (
  rawBody: string,
  signingSecret = SIGNING_SECRET
) => {
  const timestamp = String(Math.floor(clock.now().getTime() / MS_PER_SECOND));
  return {
    rawBody,
    signature: await signSlackBody({ body: rawBody, signingSecret, timestamp }),
    timestamp,
  };
};

const signedClick = (payload: Record<string, unknown>) =>
  signedRequest(`payload=${encodeURIComponent(JSON.stringify(payload))}`);

/** Runs the deferred job of an accepted interaction. Fails if the result is not accepted. */
const runAfter = async (result: InteractResult) => {
  if (result.kind !== "accepted") {
    throw new Error(`expected accepted, got ${result.kind}`);
  }
  await result.after?.();
};

beforeEach(async () => {
  db = migrated();
  calls = [];
  respond = defaultResponder;
  answerCalls = [];
  cancelCalls = [];
  answerImpl = () => Promise.resolve();
  outcomeImpl = () => Promise.resolve(null);
  clock = {
    now: () => new Date(START),
    sleep: () => Promise.resolve(),
  };
  insertWorkspace(WORKSPACE);
  insertAgent(AGENT, WORKSPACE);
  insertSession(SESSION, AGENT, WORKSPACE);

  const key = await importSecretsKey(SECRETS_KEY);
  const ref = { id: APP_ROW, workspaceId: WORKSPACE };
  db.insert(slackApps)
    .values({
      agentId: AGENT,
      appId: APP_ID,
      botToken: await encryptSecret(
        key,
        slackSecretBinding(ref, "bot_token"),
        BOT_TOKEN
      ),
      botUserId: "U0BOT",
      createdAt: START,
      id: ref.id,
      signingSecret: await encryptSecret(
        key,
        slackSecretBinding(ref, "signing_secret"),
        SIGNING_SECRET
      ),
      status: "installed",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();

  // The service methods the Slack module calls. It never reads their return
  // values, so the fakes return only what the calls need.
  const requests = {
    answer: (principal: Principal, input: AnswerCall["input"]) => {
      const call = { input, principal };
      answerCalls.push(call);
      return answerImpl(call);
    },
    cancel: async (principal: Principal, requestId: string) => {
      cancelCalls.push({ principal, requestId });
      settleRow({ answer: null, answeredVia: null, status: "cancelled" });
      await gateway.onEvent(eventOf("request.cancelled", REQUEST));
    },
    outcome: () => outcomeImpl(),
  } as unknown as Pick<RequestsService, "answer" | "cancel" | "outcome">;

  gateway = createSlackRequests({
    clock,
    db,
    fetch: slackFetch,
    publicBaseUrl: "https://hm.test",
    requests,
    secretsKey: SECRETS_KEY,
  });
});

test("posts an approval card in the Slack thread of a Slack run", async () => {
  seedRun(slackReply);
  seedRequest();

  await gateway.onEvent(eventOf("request.opened", REQUEST));

  const posts = callsTo("chat.postMessage");
  expect(posts).toHaveLength(1);
  const [post] = posts;
  expect(post?.authorization).toBe(`Bearer ${BOT_TOKEN}`);
  expect(field(post as Recorded, "channel")).toBe(CHANNEL);
  expect(field(post as Recorded, "thread_ts")).toBe(THREAD);
  const blocks = JSON.stringify(post?.body?.blocks);
  expect(blocks).toContain('"type":"actions"');
  for (const decision of ["allow_once", "always_allow", "deny"]) {
    expect(blocks).toContain(`"action_id":"hm_req:${REQUEST}:${decision}"`);
  }
  expect(readRequest()?.slackMessage).toBe(storedSlackMessage);
});

const sendDisplay = JSON.stringify({
  input: {
    connection: "hermes",
    host: "h.example",
    peer: "Hermes",
    text: "x".repeat(6000),
  },
  summary: "Send a message to Hermes",
  toolKey: "a2a_send:con_1",
  toolName: "a2a_send",
});

const seedSend = () =>
  seedRequest({
    display: sendDisplay,
    toolKey: "a2a_send:con_1",
    toolName: "a2a_send",
    toolUseId: "a2a:aot_1",
  });

test("a message to an outside agent gets a plain Slack notice with a link, no buttons and none of the text", async () => {
  seedRun(slackReply);
  seedSend();

  await gateway.onEvent(eventOf("request.opened", REQUEST));

  const [post] = callsTo("chat.postMessage");
  expect(callsTo("chat.postMessage")).toHaveLength(1);
  expect(field(post as Recorded, "thread_ts")).toBe(THREAD);
  const text = String(post?.body?.text);
  expect(text).toBe(
    "A message to Hermes is waiting for approval. Read it in full and answer at https://hm.test/desk"
  );
  expect(post?.body?.blocks).toBeUndefined();
  expect(JSON.stringify(post?.body)).not.toContain("xxxxxxxx");
  expect(readRequest()?.slackMessage).toBeNull();
});

test("the notice for a web run goes to the linked person's DM", async () => {
  seedRun(null);
  seedSend();
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);

  await gateway.onEvent(eventOf("request.opened", REQUEST));

  const posts = callsTo("chat.postMessage");
  expect(posts).toHaveLength(1);
  expect(field(posts[0] as Recorded, "channel")).toBe(DM_CHANNEL);
  expect(posts[0]?.body?.blocks).toBeUndefined();
});

test("sends a web run's card as a DM to the linked Slack user", async () => {
  seedRun(null);
  seedRequest();
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);

  await gateway.onEvent(eventOf("request.opened", REQUEST));

  const opened = callsTo("conversations.open");
  expect(opened).toHaveLength(1);
  expect(field(opened[0] as Recorded, "users")).toBe(LINKED_SLACK_ID);
  const posts = callsTo("chat.postMessage");
  expect(posts).toHaveLength(1);
  expect(field(posts[0] as Recorded, "channel")).toBe(DM_CHANNEL);
  expect(posts[0]?.body?.thread_ts).toBeUndefined();
  expect(readRequest()?.slackMessage).toBe(
    JSON.stringify({ appId: APP_ID, channel: DM_CHANNEL, ts: POSTED_TS })
  );
});

test("posts nothing when the agent's Slack app is not installed", async () => {
  db.update(slackApps)
    .set({ status: "revoked" })
    .where(eq(slackApps.id, APP_ROW))
    .run();
  seedRun(slackReply);
  seedRequest();

  await gateway.onEvent(eventOf("request.opened", REQUEST));

  expect(calls).toHaveLength(0);
  expect(readRequest()?.slackMessage).toBeNull();
});

test("posts nothing when the agent has no Slack app row", async () => {
  db.delete(slackApps).where(eq(slackApps.id, APP_ROW)).run();
  seedRun(slackReply);
  seedRequest();

  await gateway.onEvent(eventOf("request.opened", REQUEST));

  expect(calls).toHaveLength(0);
  expect(readRequest()?.slackMessage).toBeNull();
});

test("posts nothing for a web run whose person has no Slack link", async () => {
  seedRun(null);
  seedRequest();

  await gateway.onEvent(eventOf("request.opened", REQUEST));

  expect(calls).toHaveLength(0);
  expect(readRequest()?.slackMessage).toBeNull();
});

test("posts nothing for a run with no person and no Slack reply", async () => {
  seedRun(null, null);
  seedRequest();

  await gateway.onEvent(eventOf("request.opened", REQUEST));

  expect(calls).toHaveLength(0);
  expect(readRequest()?.slackMessage).toBeNull();
});

test("does not post a second card for a request that already has one", async () => {
  seedRun(slackReply);
  seedRequest({ slackMessage: storedSlackMessage });

  await gateway.onEvent(eventOf("request.opened", REQUEST));

  expect(calls).toHaveLength(0);
  expect(readRequest()?.slackMessage).toBe(storedSlackMessage);
});

test("settles the card with the web answer when the request is answered", async () => {
  seedRun(slackReply);
  seedRequest({ slackMessage: storedSlackMessage });
  settleRow({
    answer: JSON.stringify({ decision: "deny" }),
    answeredVia: "web",
    status: "answered",
  });

  await gateway.onEvent(eventOf("request.answered", REQUEST));

  const updates = callsTo("chat.update");
  expect(updates).toHaveLength(1);
  const [update] = updates;
  expect(field(update as Recorded, "channel")).toBe(CHANNEL);
  expect(field(update as Recorded, "ts")).toBe(POSTED_TS);
  expect(field(update as Recorded, "text")).toContain("Denied");
  expect(field(update as Recorded, "text")).toContain("the web");
  expect(JSON.stringify(update?.body?.blocks)).not.toContain(
    '"type":"actions"'
  );
});

test("settles the card with Slack when the request was answered in Slack", async () => {
  seedRun(slackReply);
  seedRequest({ slackMessage: storedSlackMessage });
  settleRow({
    answer: JSON.stringify({ decision: "deny" }),
    answeredVia: "slack",
    status: "answered",
  });

  await gateway.onEvent(eventOf("request.answered", REQUEST));

  const [update] = callsTo("chat.update");
  expect(field(update as Recorded, "text")).toContain("Denied");
  expect(field(update as Recorded, "text")).toContain("Slack");
});

test("settles an expired or cancelled card", async () => {
  seedRun(slackReply);
  seedRequest({ slackMessage: storedSlackMessage });

  settleRow({ answer: null, answeredVia: null, status: "expired" });
  await gateway.onEvent(eventOf("request.expired", REQUEST));
  expect(field(callsTo("chat.update")[0] as Recorded, "text")).toContain(
    "Expired"
  );

  settleRow({ answer: null, answeredVia: null, status: "cancelled" });
  await gateway.onEvent(eventOf("request.cancelled", REQUEST));
  expect(field(callsTo("chat.update")[1] as Recorded, "text")).toContain(
    "Cancelled"
  );
});

test("makes no Slack call when a closed request never had a card", async () => {
  seedRun(slackReply);
  seedRequest();
  settleRow({ answer: null, answeredVia: null, status: "expired" });

  await gateway.onEvent(eventOf("request.expired", REQUEST));

  expect(calls).toHaveLength(0);
});

test("settles the card when the request closes while the card is posted", async () => {
  seedRun(slackReply);
  seedRequest();
  respond = (call) => {
    if (call.url === `${SLACK_API}chat.postMessage`) {
      // The request is answered on the web before Slack answers the post.
      settleRow({
        answer: JSON.stringify({ decision: "allow_once" }),
        answeredVia: "web",
        status: "answered",
      });
    }
    return defaultResponder(call);
  };

  await gateway.onEvent(eventOf("request.opened", REQUEST));

  expect(callsTo("chat.postMessage")).toHaveLength(1);
  const updates = callsTo("chat.update");
  expect(updates).toHaveLength(1);
  expect(field(updates[0] as Recorded, "ts")).toBe(POSTED_TS);
  expect(field(updates[0] as Recorded, "text")).toContain("the web");
});

test("answers a Deny click from a linked user after the response", async () => {
  seedRun(slackReply);
  seedRequest({ slackMessage: storedSlackMessage });
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);
  answerImpl = async (call) => {
    settleRow({
      answer: JSON.stringify(call.input.answer),
      answeredVia: "slack",
      status: "answered",
    });
    await gateway.onEvent(eventOf("request.answered", REQUEST));
  };

  const request = await signedClick(clickPayload());
  const result = await gateway.interact(request);

  expect(answerCalls).toHaveLength(0);
  await runAfter(result);

  expect(answerCalls).toHaveLength(1);
  const [answered] = answerCalls;
  expect(answered?.principal).toEqual({
    kind: "user",
    userId: CLERK_USER,
    via: "slack",
    workspaceId: WORKSPACE,
  });
  expect(answered?.input).toEqual({
    answer: { decision: "deny" },
    requestId: REQUEST,
    via: "slack",
  });
  const [update] = callsTo("chat.update");
  expect(field(update as Recorded, "text")).toContain("Denied");
  expect(field(update as Recorded, "text")).toContain("Slack");
});

test("shows the web answer on the card when Slack's click came second", async () => {
  seedRun(slackReply);
  seedRequest({ slackMessage: storedSlackMessage });
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);
  answerImpl = () => {
    settleRow({
      answer: JSON.stringify({ decision: "allow_once" }),
      answeredVia: "web",
      status: "answered",
    });
    return Promise.reject(new ServiceError("conflict", "Already answered"));
  };

  const result = await gateway.interact(await signedClick(clickPayload()));
  await runAfter(result);

  expect(answerCalls).toHaveLength(1);
  const [update] = callsTo("chat.update");
  expect(field(update as Recorded, "text")).toContain("the web");
});

test("settles without answering when the outcome is already settled", async () => {
  seedRun(slackReply);
  seedRequest({ slackMessage: storedSlackMessage });
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);
  settleRow({
    answer: JSON.stringify({ decision: "allow_once" }),
    answeredVia: "web",
    status: "answered",
  });
  outcomeImpl = () =>
    Promise.resolve({
      answer: { decision: "allow_once" },
      status: "answered",
    });

  const result = await gateway.interact(await signedClick(clickPayload()));
  await runAfter(result);

  expect(answerCalls).toHaveLength(0);
  const [update] = callsTo("chat.update");
  expect(field(update as Recorded, "text")).toContain("the web");
});

test("refuses a click from a Slack user with no link, privately", async () => {
  seedRun(slackReply);
  seedRequest({ slackMessage: storedSlackMessage });

  const result = await gateway.interact(
    await signedClick(clickPayload({ slackUserId: STRANGER_SLACK_ID }))
  );
  await runAfter(result);

  expect(answerCalls).toHaveLength(0);
  const [ephemeral] = callsTo("chat.postEphemeral");
  expect(ephemeral?.body).toMatchObject({
    channel: CHANNEL,
    text: CANT_ANSWER,
    user: STRANGER_SLACK_ID,
  });
});

test("refuses a click on a request the person cannot read, privately", async () => {
  seedRun(slackReply);
  seedRequest({ slackMessage: storedSlackMessage });
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);
  outcomeImpl = () =>
    Promise.reject(new ServiceError("not_found", "Request not found"));

  const result = await gateway.interact(await signedClick(clickPayload()));
  await runAfter(result);

  expect(answerCalls).toHaveLength(0);
  const [ephemeral] = callsTo("chat.postEphemeral");
  expect(ephemeral?.body).toMatchObject({
    channel: CHANNEL,
    text: CANT_ANSWER,
    user: LINKED_SLACK_ID,
  });
});

test("ignores a click on a request of another agent's app", async () => {
  insertAgent(OTHER_AGENT, WORKSPACE);
  insertSession("s2", OTHER_AGENT, WORKSPACE);
  db.insert(runRows)
    .values({
      actorId: CLERK_USER,
      actorKind: "user",
      agentId: OTHER_AGENT,
      createdAt: START,
      id: "r2",
      inputText: "hi",
      onBehalfOfUserId: CLERK_USER,
      reply: JSON.stringify(slackReply),
      sessionId: "s2",
      status: "running",
      workspaceId: WORKSPACE,
    })
    .run();
  seedRequest({ agentId: OTHER_AGENT, runId: "r2", sessionId: "s2" });
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);

  const result = await gateway.interact(await signedClick(clickPayload()));
  await runAfter(result);

  expect(calls).toHaveLength(0);
  expect(answerCalls).toHaveLength(0);
});

test("ignores a click on a request of another workspace", async () => {
  insertWorkspace(OTHER_WORKSPACE);
  insertAgent(OTHER_AGENT, OTHER_WORKSPACE);
  insertSession("s2", OTHER_AGENT, OTHER_WORKSPACE);
  db.insert(runRows)
    .values({
      actorId: CLERK_USER,
      actorKind: "user",
      agentId: OTHER_AGENT,
      createdAt: START,
      id: "r2",
      inputText: "hi",
      onBehalfOfUserId: CLERK_USER,
      reply: JSON.stringify(slackReply),
      sessionId: "s2",
      status: "running",
      workspaceId: OTHER_WORKSPACE,
    })
    .run();
  seedRequest({
    agentId: OTHER_AGENT,
    runId: "r2",
    sessionId: "s2",
    workspaceId: OTHER_WORKSPACE,
  });
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);

  const result = await gateway.interact(await signedClick(clickPayload()));
  await runAfter(result);

  expect(calls).toHaveLength(0);
  expect(answerCalls).toHaveLength(0);
});

test("refuses an unsigned or badly signed body as unauthorized", async () => {
  seedRun(slackReply);
  seedRequest({ slackMessage: storedSlackMessage });
  const request = await signedClick(clickPayload());

  const result = await gateway.interact({
    ...request,
    signature: BAD_SIGNATURE,
  });

  expect(result).toEqual({ kind: "unauthorized" });
  expect(answerCalls).toHaveLength(0);
});

test("refuses a payload for an app this server does not know as unauthorized", async () => {
  const request = await signedClick({
    ...clickPayload(),
    api_app_id: "A0UNKNOWN",
  });

  expect(await gateway.interact(request)).toEqual({ kind: "unauthorized" });
});

test("refuses a body with no payload field as malformed", async () => {
  const request = await signedRequest("token=abc&team_id=T0TEAM");

  expect(await gateway.interact(request)).toEqual({ kind: "malformed" });
});

const takeoverSeed = {
  display: JSON.stringify({ machineId: "computer", reason: "Please log in" }),
  kind: "takeover" as const,
};

for (const reply of [slackReply, null]) {
  test(`posts takeover in ${reply ? "thread" : "DM"} with screen link`, async () => {
    seedRun(reply);
    linkSlackUser(LINKED_SLACK_ID, CLERK_USER);
    seedRequest(takeoverSeed);
    await gateway.onEvent(eventOf("request.opened", REQUEST));
    const [post] = callsTo("chat.postMessage");
    expect(post?.body?.channel).toBe(reply ? CHANNEL : DM_CHANNEL);
    expect(post?.body?.thread_ts).toBe(reply ? THREAD : undefined);
    expect(JSON.stringify(post?.body?.blocks)).toContain(
      "https://hm.test/tasks/r1#computer"
    );
    expect(post?.body?.text).toContain("Cloud: Please log in");
    expect(readRequest()?.slackMessage).not.toBeNull();
  });
}

test("updates takeover when handed back on the web, resolving the person's name", async () => {
  seedRun(slackReply);
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);
  seedRequest({ ...takeoverSeed, slackMessage: storedSlackMessage });
  respond = (call) =>
    call.url.startsWith(`${SLACK_API}users.info?`)
      ? json({
          ok: true,
          user: {
            id: LINKED_SLACK_ID,
            name: "dom",
            profile: { display_name: "Dom" },
            real_name: "Dom",
          },
        })
      : defaultResponder(call);
  settleRow({ answer: "{}", answeredVia: "web", status: "answered" });
  await gateway.onEvent(eventOf("request.answered", REQUEST));
  const [update] = callsTo("chat.update");
  expect(update?.body?.text).toContain("Handed back by Dom");
  expect(JSON.stringify(update?.body?.blocks)).not.toContain(
    '"type":"actions"'
  );
});

test("cancel takeover calls cancel after response and updates the card", async () => {
  seedRun(slackReply);
  seedRequest({ ...takeoverSeed, slackMessage: storedSlackMessage });
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);
  const result = await gateway.interact(
    await signedClick(clickPayload({ actionId: `hm_req:${REQUEST}:cancel` }))
  );
  expect(cancelCalls).toHaveLength(0);
  await runAfter(result);
  expect(cancelCalls).toEqual([
    {
      principal: {
        kind: "user",
        userId: CLERK_USER,
        via: "slack",
        workspaceId: WORKSPACE,
      },
      requestId: REQUEST,
    },
  ]);
  expect(answerCalls).toHaveLength(0);
  expect(callsTo("chat.update")[0]?.body?.text).toContain("Cancelled");
});

test("unlinked users cannot cancel takeover and Slack cannot hand it back", async () => {
  seedRun(slackReply);
  seedRequest(takeoverSeed);
  await runAfter(
    await gateway.interact(
      await signedClick(
        clickPayload({
          actionId: `hm_req:${REQUEST}:cancel`,
          slackUserId: STRANGER_SLACK_ID,
        })
      )
    )
  );
  expect(cancelCalls).toHaveLength(0);
  expect(callsTo("chat.postEphemeral")).toHaveLength(1);
  linkSlackUser(LINKED_SLACK_ID, CLERK_USER);
  await runAfter(await gateway.interact(await signedClick(clickPayload())));
  expect(answerCalls).toHaveLength(0);
});

for (const linked of [true, false]) {
  test(`hand-back name falls back to ${linked ? "linked email" : "user id"}`, async () => {
    seedRun(slackReply);
    seedRequest({ ...takeoverSeed, slackMessage: storedSlackMessage });
    if (linked) {
      linkSlackUser(LINKED_SLACK_ID, CLERK_USER);
    }
    settleRow({ answer: "{}", answeredVia: "web", status: "answered" });
    await gateway.onEvent(eventOf("request.answered", REQUEST));
    expect(callsTo("chat.update")[0]?.body?.text).toContain(
      `Handed back by ${linked ? "person@example.test" : CLERK_USER}`
    );
  });
}

test("takeover cancellation elsewhere updates its card without actions", async () => {
  seedRun(slackReply);
  seedRequest({ ...takeoverSeed, slackMessage: storedSlackMessage });
  settleRow({ answer: null, answeredVia: null, status: "cancelled" });
  await gateway.onEvent(eventOf("request.cancelled", REQUEST));
  const [update] = callsTo("chat.update");
  expect(update?.body?.text).toContain("Cancelled");
  expect(JSON.stringify(update?.body?.blocks)).not.toContain(
    '"type":"actions"'
  );
  expect(cancelCalls).toHaveLength(0);
});
