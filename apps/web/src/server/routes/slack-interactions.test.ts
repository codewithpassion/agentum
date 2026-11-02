import { beforeEach, expect, test } from "bun:test";
import { type Atomic, sqliteAtomic } from "@repo/db/atomic";
import { runRequests } from "@repo/db/schema/requests";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { slackApps } from "@repo/db/schema/slack";
import { identityLinks } from "@repo/db/schema/workspaces";
import { APPROVAL_TTL_MS } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { encryptSecret, importSecretsKey } from "@repo/services/crypto";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import type { Clock } from "@repo/services/runs/types";
import { slackSecretBinding } from "@repo/services/slack/apps";
import { signSlackBody } from "@repo/services/slack/signature";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { slackRoutes } from "./slack.ts";

const ORG = "org_a";
const SECRET = "test-signing-secret";
const SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const BOT_TOKEN = "xoxb-test-token";
const APP_ID = "A0APP";
const TEAM = "T0TEAM";
const CHANNEL = "C0CHAN";
const THREAD_TS = "1789171300.000100";
const CARD_TS = "1789171301.000200";
const TRIGGER_ID = "1234.5678.abcd";
const DOM = "user_dom";
const OWNER = "user_owner";
const OTHER = "user_other";
const SLACK_DOM = "U0DOM";
const SLACK_STRANGER = "U0STRANGER";
const SECOND_MS = 1000;
const OK = 200;
const UNAUTHORIZED = 401;
const BAD_REQUEST = 400;
const CANT_ANSWER = "You can't answer this one.";
const APPROVAL_TOOL_USE = "tu1";
const QUESTION_TOOL_USE = "tu2";

interface SlackCall {
  body: Record<string, unknown>;
  method: string;
}

let db: ReturnType<typeof migrated>;
let composed: Composed;
let app: Hono<AppEnv>;
let nowMs: number;
let workspaceId: string;
let agentId: string;
/** Route jobs: each one runs an interaction's work when called. */
let routeJobs: (() => Promise<void>)[];
/** Service jobs: card posts and settles, already started when collected. */
let serviceJobs: Promise<void>[];
let slackCalls: SlackCall[];

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: (ms) => {
    nowMs += ms;
    return Promise.resolve();
  },
};

/** Answers like Slack's Web API and records every call the app makes. */
const fakeSlack = (
  url: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const address = new URL(typeof url === "string" ? url : String(url));
  const method = address.pathname.replace("/api/", "");
  const body: Record<string, unknown> =
    typeof init?.body === "string" ? JSON.parse(init.body) : {};
  slackCalls.push({ body, method });
  const answers: Record<string, unknown> = {
    "chat.postEphemeral": { ok: true },
    "chat.postMessage": { ok: true, ts: CARD_TS },
    "chat.update": { ok: true },
    "views.open": { ok: true },
  };
  return Promise.resolve(Response.json(answers[method] ?? { ok: true }));
};

const testInfra = (): Infra => {
  const atomic: Atomic = sqliteAtomic(db);
  return {
    atomic,
    blobs: {
      get: () => Promise.resolve(null),
      put: () => Promise.resolve(),
    },
    clock,
    defer: (work) => {
      serviceJobs.push(work);
    },
    devFakeRuntime: true,
    fetch: fakeSlack,
    fileBlobs: memoryFileBlobs(),
    publicBaseUrl: "https://hm.test",
    relay: noopRelay,
    secretsKey: SECRETS_KEY,
  };
};

beforeEach(async () => {
  db = migrated([ORG]);
  nowMs = Date.parse("2026-10-16T10:00:00.000Z");
  routeJobs = [];
  serviceJobs = [];
  slackCalls = [];
  composed = composeWith({
    db,
    infra: testInfra(),
  });
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: ORG,
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  workspaceId = workspace.id;
  const owner = {
    kind: "user",
    userId: OWNER,
    via: "session",
    workspaceId,
  } as const;
  const { code } = await composed.services.machines.createEnrollToken(owner, {
    machineName: "box",
  });
  const machine = await composed.services.machines.enroll({
    code,
    singleUser: false,
  });
  if (!machine) {
    throw new Error("enrol failed");
  }
  agentId = (
    await composed.services.agents.create(owner, {
      machineId: machine.machineId,
      model: "m",
      name: "Bruce",
      runtime: "machine",
    })
  ).id;
  await installApp();
  await db.insert(identityLinks).values({
    clerkUserId: DOM,
    createdAt: new Date(nowMs).toISOString(),
    email: "dom@example.com",
    externalUserId: SLACK_DOM,
    id: "link_dom",
    provider: "slack",
    teamId: TEAM,
    workspaceId,
  });
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("composed", composed);
    await next();
  });
  app.route(
    "/api/slack",
    slackRoutes({
      defer: (_c, job) => {
        routeJobs.push(job);
      },
    })
  );
  app.onError((_error, c) => c.text("error", 500));
});

const installApp = async () => {
  const key = await importSecretsKey(SECRETS_KEY);
  const row = { id: "app_row_1", workspaceId };
  await db.insert(slackApps).values({
    agentId,
    appId: APP_ID,
    botToken: await encryptSecret(
      key,
      slackSecretBinding(row, "bot_token"),
      BOT_TOKEN
    ),
    botUserId: "U0BOT",
    createdAt: new Date(nowMs).toISOString(),
    id: row.id,
    signingSecret: await encryptSecret(
      key,
      slackSecretBinding(row, "signing_secret"),
      SECRET
    ),
    status: "installed",
    teamId: TEAM,
    workspaceId,
  });
};

/** Runs the work the routes and services left for after the answer. */
const runAfterJobs = async (): Promise<void> => {
  const jobs = routeJobs.splice(0);
  await Promise.all(jobs.map((job) => job()));
  // A job can start more card work, so drain until nothing is left.
  const cards = serviceJobs.splice(0);
  if (cards.length > 0) {
    await Promise.all(cards);
    await runAfterJobs();
  }
};

/** A Slack run in the thread, started and claimed, as the Events route leaves it. */
const startSlackRun = async (): Promise<string> => {
  const run = await composed.services.runs.startRun(
    { kind: "user", userId: DOM, via: "slack", workspaceId },
    {
      agentId,
      input: { text: "ship it?" },
      reply: {
        channel: CHANNEL,
        kind: "slack",
        teamId: TEAM,
        threadTs: THREAD_TS,
      },
      session: {
        externalKey: `${TEAM}:${CHANNEL}:${THREAD_TS}`,
        origin: "slack",
      },
    }
  );
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, run.runId);
  return run.runId;
};

const openApproval = async (runId: string) =>
  composed.services.requests.open(SYSTEM_PRINCIPAL, {
    input: { command: "ls" },
    kind: "approval",
    runId,
    toolName: "bash",
    toolUseId: APPROVAL_TOOL_USE,
  });

const TWO_QUESTIONS = [
  { question: "Which?", choices: ["A", "B"] },
  { question: "Why?" },
];

const openQuestion = async (
  runId: string,
  questions: { question: string; choices?: string[] }[] = [
    { choices: ["A", "B"], question: "Which?" },
  ]
) =>
  composed.services.requests.open(SYSTEM_PRINCIPAL, {
    kind: "question",
    questions,
    runId,
    toolName: "ask",
    toolUseId: QUESTION_TOOL_USE,
  });

/** Opens a request and posts its card, as the service does in the background. */
const openWithCard = async (
  open: () => Promise<{ id: string }>
): Promise<string> => {
  const request = await open();
  await runAfterJobs();
  return request.id;
};

const requestRow = async (requestId: string) => {
  const [row] = await db
    .select()
    .from(runRequests)
    .where(eq(runRequests.id, requestId));
  if (!row) {
    throw new Error("request row is missing");
  }
  return row;
};

const blockAction = (
  actionId: string,
  slackUser: string = SLACK_DOM,
  apiAppId: string = APP_ID
) => ({
  actions: [{ action_id: actionId }],
  api_app_id: apiAppId,
  channel: { id: CHANNEL },
  team: { id: TEAM },
  trigger_id: TRIGGER_ID,
  type: "block_actions",
  user: { id: slackUser },
});

const submission = (
  requestId: string,
  values: Record<string, Record<string, unknown>>,
  slackUser: string = SLACK_DOM
) => ({
  api_app_id: APP_ID,
  team: { id: TEAM },
  type: "view_submission",
  user: { id: slackUser },
  view: {
    callback_id: `hm_req_modal:${requestId}`,
    state: { values },
  },
});

const rawPost = (body: string, signature: string, timestamp: string) =>
  app.request("/api/slack/interactions", {
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
    },
    method: "POST",
  });

/** Sends an interaction the way Slack does: a form body with the JSON in `payload`, signed. */
const send = async (
  payload: unknown,
  options: { signingSecret?: string } = {}
) => {
  const body = new URLSearchParams({
    payload: JSON.stringify(payload),
  }).toString();
  const timestamp = String(Math.floor(nowMs / SECOND_MS));
  const signature = await signSlackBody({
    body,
    signingSecret: options.signingSecret ?? SECRET,
    timestamp,
  });
  return await rawPost(body, signature, timestamp);
};

const methods = () => slackCalls.map((call) => call.method);
const callsTo = (method: string) =>
  slackCalls.filter((call) => call.method === method);

test("a bad signature, an unknown app or a body that is not an interaction is refused before anything runs", async () => {
  const runId = await startSlackRun();
  const requestId = await openWithCard(() => openApproval(runId));
  slackCalls = [];

  const forged = await send(blockAction(`hm_req:${requestId}:deny`), {
    signingSecret: "not the secret",
  });
  expect(forged.status).toBe(UNAUTHORIZED);
  expect(await forged.text()).toContain("Slack");

  const unknown = await send(
    blockAction(`hm_req:${requestId}:deny`, SLACK_DOM, "A0OTHER")
  );
  expect(unknown.status).toBe(UNAUTHORIZED);

  const noPayload = await rawPost(
    "other=1",
    await signSlackBody({
      body: "other=1",
      signingSecret: SECRET,
      timestamp: String(Math.floor(nowMs / SECOND_MS)),
    }),
    String(Math.floor(nowMs / SECOND_MS))
  );
  expect(noPayload.status).toBe(BAD_REQUEST);

  const notJson = new URLSearchParams({ payload: "{not json" }).toString();
  const timestamp = String(Math.floor(nowMs / SECOND_MS));
  const badJson = await rawPost(
    notJson,
    await signSlackBody({
      body: notJson,
      signingSecret: SECRET,
      timestamp,
    }),
    timestamp
  );
  expect(badJson.status).toBe(BAD_REQUEST);

  await runAfterJobs();
  expect(methods()).toEqual([]);
  expect((await requestRow(requestId)).status).toBe("pending");
});

test("a Deny click is acknowledged before the answer, then answers and settles the card", async () => {
  const runId = await startSlackRun();
  const requestId = await openWithCard(() => openApproval(runId));
  slackCalls = [];

  const response = await send(blockAction(`hm_req:${requestId}:deny`));
  expect(response.status).toBe(OK);
  expect(await response.text()).toBe("");

  // The answer waits for the deferred job.
  const before = await requestRow(requestId);
  expect(before.status).toBe("pending");
  expect(before.answeredVia).toBeNull();
  expect(routeJobs).toHaveLength(1);
  expect(methods()).toEqual([]);

  await runAfterJobs();
  const row = await requestRow(requestId);
  expect(row).toMatchObject({
    answeredBy: DOM,
    answeredVia: "slack",
    status: "answered",
  });
  expect(JSON.parse(row.answer ?? "null")).toEqual({ decision: "deny" });

  const [update] = callsTo("chat.update");
  expect(update?.body.channel).toBe(CHANNEL);
  expect(update?.body.ts).toBe(CARD_TS);
  const text = String(update?.body.text);
  expect(text).toContain("Denied");
  expect(text).toContain("Slack");
  const blocks = update?.body.blocks as { type: string }[];
  expect(blocks.some((block) => block.type === "actions")).toBe(false);
});

test("the Answer button on a question card opens the modal with the click's trigger", async () => {
  const runId = await startSlackRun();
  const requestId = await openWithCard(() =>
    openQuestion(runId, TWO_QUESTIONS)
  );
  slackCalls = [];

  const response = await send(blockAction(`hm_req:${requestId}:modal`));
  expect(response.status).toBe(OK);
  expect(await response.text()).toBe("");
  await runAfterJobs();

  const [opened] = callsTo("views.open");
  expect(opened?.body.trigger_id).toBe(TRIGGER_ID);
  expect(opened?.body.view).toMatchObject({
    callback_id: `hm_req_modal:${requestId}`,
    type: "modal",
  });
  expect((await requestRow(requestId)).status).toBe("pending");
});

test("a modal submission answers with the typed text and the chosen option, keyed by question", async () => {
  const runId = await startSlackRun();
  const requestId = await openWithCard(() =>
    openQuestion(runId, TWO_QUESTIONS)
  );
  slackCalls = [];

  const response = await send(
    submission(requestId, {
      c0: {
        choice: { selected_option: { value: "1" }, type: "radio_buttons" },
      },
      q0: { text: { type: "plain_text_input", value: "" } },
      q1: { text: { type: "plain_text_input", value: "Because" } },
    })
  );
  expect(response.status).toBe(OK);
  expect(await response.text()).toBe("");

  await runAfterJobs();
  const row = await requestRow(requestId);
  expect(row).toMatchObject({ answeredVia: "slack", status: "answered" });
  expect(JSON.parse(row.answer ?? "null")).toEqual({
    answers: { "Which?": "B", "Why?": "Because" },
  });
  const [update] = callsTo("chat.update").slice(-1);
  expect(String(update?.body.text)).toContain("Answered on Slack");
});

test("a choice button on a one-question request answers with that choice", async () => {
  const runId = await startSlackRun();
  const requestId = await openWithCard(() => openQuestion(runId));
  slackCalls = [];

  const response = await send(blockAction(`hm_req:${requestId}:choice:0:1`));
  expect(response.status).toBe(OK);
  await runAfterJobs();

  const row = await requestRow(requestId);
  expect(row).toMatchObject({ answeredVia: "slack", status: "answered" });
  expect(JSON.parse(row.answer ?? "null")).toEqual({
    answers: { "Which?": "B" },
  });
});

test("a click from a Slack user with no identity link is refused privately and changes nothing", async () => {
  const runId = await startSlackRun();
  const requestId = await openWithCard(() => openApproval(runId));
  slackCalls = [];

  const response = await send(
    blockAction(`hm_req:${requestId}:deny`, SLACK_STRANGER)
  );
  expect(response.status).toBe(OK);
  expect(await response.text()).toBe("");
  await runAfterJobs();

  const [ephemeral] = callsTo("chat.postEphemeral");
  expect(ephemeral?.body).toMatchObject({
    channel: CHANNEL,
    text: CANT_ANSWER,
    user: SLACK_STRANGER,
  });
  expect((await requestRow(requestId)).status).toBe("pending");
  expect(callsTo("chat.update")).toEqual([]);
});

test("a user who cannot see the run's session is refused on a click and on a submission", async () => {
  const runId = await startSlackRun();
  const requestId = await openWithCard(() =>
    openQuestion(runId, TWO_QUESTIONS)
  );
  const [session] = await db.select().from(sessionRows);
  if (!session) {
    throw new Error("the run has no session");
  }
  // A private UI session of another person: DOM is linked but cannot see it.
  await db
    .update(sessionRows)
    .set({ actorId: OTHER, origin: "ui", private: true })
    .where(eq(sessionRows.id, session.id));
  slackCalls = [];

  const click = await send(blockAction(`hm_req:${requestId}:modal`));
  expect(click.status).toBe(OK);
  await runAfterJobs();
  expect(callsTo("views.open")).toEqual([]);
  expect(callsTo("chat.postEphemeral")[0]?.body.text).toBe(CANT_ANSWER);

  const modal = await send(
    submission(requestId, {
      q0: { text: { type: "plain_text_input", value: "hello" } },
      q1: { text: { type: "plain_text_input", value: "why" } },
    })
  );
  expect(modal.status).toBe(OK);
  expect(await modal.json()).toEqual({
    errors: { q0: CANT_ANSWER },
    response_action: "errors",
  });
  await runAfterJobs();
  expect((await requestRow(requestId)).status).toBe("pending");
});

test("a second Slack click after a web answer changes nothing and the card says the web answered", async () => {
  const runId = await startSlackRun();
  const requestId = await openWithCard(() => openApproval(runId));
  await composed.services.requests.answer(
    { kind: "user", userId: DOM, via: "session", workspaceId },
    {
      answer: { decision: "allow_once" },
      requestId,
      via: "web",
    }
  );
  await runAfterJobs();
  const webUpdates = callsTo("chat.update").filter((call) =>
    String(call.body.text).includes("the web")
  );
  expect(webUpdates).not.toHaveLength(0);
  const { answeredAt } = await requestRow(requestId);
  slackCalls = [];

  const response = await send(blockAction(`hm_req:${requestId}:deny`));
  expect(response.status).toBe(OK);
  await runAfterJobs();

  const row = await requestRow(requestId);
  expect(row).toMatchObject({ answeredVia: "web", status: "answered" });
  expect(row.answeredAt).toBe(answeredAt);
  expect(JSON.parse(row.answer ?? "null")).toEqual({ decision: "allow_once" });
  expect(
    callsTo("chat.update").some((call) =>
      String(call.body.text).includes("the web")
    )
  ).toBe(true);
});

test("an approval that expires settles its card as expired", async () => {
  const runId = await startSlackRun();
  await openWithCard(() => openApproval(runId));
  nowMs += APPROVAL_TTL_MS;
  slackCalls = [];

  await composed.services.requests.expireDue(SYSTEM_PRINCIPAL);
  await runAfterJobs();

  const [update] = callsTo("chat.update");
  expect(String(update?.body.text)).toContain("Expired");
});
