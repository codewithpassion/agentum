import { beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { type Atomic, sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { files as fileRows } from "@repo/db/schema/files";
import { inboxPosts, inboxThreads } from "@repo/db/schema/inbox";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import {
  slackApps,
  slackEventsSeen,
  slackRoomMessages,
  slackThreads,
  teamSlackLinks,
} from "@repo/db/schema/slack";
import { teams as teamRows } from "@repo/db/schema/teams";
import { identityLinks } from "@repo/db/schema/workspaces";
import { taskFolderPath } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { encryptSecret, importSecretsKey } from "@repo/services/crypto";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import type { Clock } from "@repo/services/runs/types";
import type { SlackDirectory } from "@repo/services/slack";
import { slackSecretBinding } from "@repo/services/slack/apps";
import { signSlackBody } from "@repo/services/slack/signature";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { file as bunFile } from "bun";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { slackRoutes } from "./slack.ts";

const ORG = "org_a";
const SECRET = "test-signing-secret";
const SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const BOT_TOKEN = "xoxb-test-token";
const DOM = "user_dom";
const MINUTE_MS = 60_000;
const SECOND_MS = 1000;
const STATUS_METHOD = "assistant.threads.setStatus";
const OK = 200;
const UNAUTHORIZED = 401;
const SERVER_ERROR = 500;
const FIXTURES = new URL(
  "../../../../../scripts/dev/fixtures/",
  import.meta.url
);
const PDF_URL =
  "https://files.slack.com/files-pri/T0TEAM-F0PDF/download/plan.pdf";
const UPLOAD_URL = "https://files.slack.com/upload/v1/abc";
const OUTPUT_FILE_ID = "F0OUT";
const SUMMARY_NAME = "summary.txt";
const SUMMARY_CONTENT = "Launch is on track.";
const SUMMARY_TEXT = "Here is the summary.";
const DM_FILE_THREAD_TS = "1789171203.000300";
const BEARER_TOKEN = /^Bearer xoxb-/;
const UNLINKED_TEXT =
  "I don't know you yet. Ask an Agentum admin of this workspace to invite you, using the same email address as your Slack profile.";
const HIDDEN_EMAIL_TEXT =
  "I can't see the email address on your Slack profile, so I can't match you to an Agentum account. Ask an Agentum admin of this workspace to invite you, and make your email visible to apps in your Slack profile.";

type Fixture = Record<string, unknown> & { event: Record<string, unknown> };

interface SlackCall {
  auth: string | null;
  body: Record<string, unknown>;
  method: string;
  query?: Record<string, string>;
  text?: string;
}

let db: ReturnType<typeof migrated>;
let composed: Composed;
let infra: Infra;
let app: Hono<AppEnv>;
let nowMs: number;
let workspaceId: string;
let agentId: string;
let machineId: string;
let deferred: (() => Promise<void>)[];
let dropDeferred: boolean;
let failAtomic: boolean;
let slackCalls: SlackCall[];
let slackEmail: string | null;
let slackUserTeam: string;
let downloadStatus: number;
let statusAnswer: Record<string, unknown>;
let postSeq: number;
let postAnswer: (call: SlackCall) => Response | null;
let outOfChannel: Set<string>;
let directory: {
  emailOwner: string | null;
  member: boolean;
};

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: (ms) => {
    nowMs += ms;
    return Promise.resolve();
  },
};

const fixture = async (name: string): Promise<Fixture> =>
  (await bunFile(new URL(`${name}.json`, FIXTURES)).json()) as Fixture;

/** Answers like Slack and records what the app sent. */
const fakeSlack = async (
  url: string | URL | Request,
  init?: RequestInit
): Promise<Response> => {
  const address = new URL(typeof url === "string" ? url : String(url));
  const headers = new Headers(init?.headers);
  const verb = (init?.method ?? "GET").toUpperCase();
  if (address.host === "files.slack.com" && verb === "GET") {
    slackCalls.push({
      auth: headers.get("Authorization"),
      body: {},
      method: "download",
    });
    return downloadStatus === OK
      ? new Response("%PDF-1.4 plan", {
          headers: { "Content-Type": "application/pdf" },
        })
      : new Response("nope", { status: downloadStatus });
  }
  if (address.host === "files.slack.com") {
    slackCalls.push({
      auth: headers.get("Authorization"),
      body: {},
      method: "upload",
      text: await new Response(init?.body ?? null).text(),
    });
    return new Response("OK");
  }
  const method = address.pathname.replace("/api/", "");
  const body: Record<string, unknown> =
    typeof init?.body === "string" ? JSON.parse(init.body) : {};
  const call: SlackCall = {
    auth: headers.get("Authorization"),
    body,
    method,
    query: Object.fromEntries(address.searchParams),
  };
  slackCalls.push(call);
  if (method === "chat.postMessage") {
    const answered = postAnswer(call);
    if (answered) {
      return answered;
    }
  }
  const postTs = `1789171300.${String(postSeq).padStart(6, "0")}`;
  if (method === "chat.postMessage") {
    postSeq += 1;
  }
  const answers: Record<string, unknown> = {
    "chat.postEphemeral": { ok: true },
    "chat.postMessage": { ok: true, ts: postTs },
    "conversations.info":
      address.searchParams.get("channel") === "C0GONE"
        ? { error: "channel_not_found", ok: false }
        : {
            channel: {
              id: "C0CHAN",
              is_member: !outOfChannel.has(
                (headers.get("Authorization") ?? "").replace("Bearer ", "")
              ),
              name: "launch",
            },
            ok: true,
          },
    "files.completeUploadExternal": { ok: true },
    "files.getUploadURLExternal": {
      file_id: OUTPUT_FILE_ID,
      ok: true,
      upload_url: UPLOAD_URL,
    },
    [STATUS_METHOD]: statusAnswer,
    "users.info": {
      ok: true,
      user: {
        id: "U0NEW",
        profile: { email: slackEmail, real_name: "Newcomer" },
        team_id: slackUserTeam,
      },
    },
  };
  return Response.json(answers[method] ?? { ok: false });
};

const clerk: SlackDirectory = {
  findUserIdByEmail: () => Promise.resolve(directory.emailOwner),
  isOrgMember: () => Promise.resolve(directory.member),
};

const atomicOrFail =
  (inner: Atomic): Atomic =>
  (statements) =>
    failAtomic ? Promise.reject(new Error("d1 is down")) : inner(statements);

const testInfra = (): Infra => ({
  atomic: atomicOrFail(sqliteAtomic(db)),
  blobs: {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  },
  clock,
  devFakeRuntime: true,
  fetch: fakeSlack,
  fileBlobs: memoryFileBlobs(),
  publicBaseUrl: "https://hm.test",
  relay: noopRelay,
  secretsKey: SECRETS_KEY,
  slackDirectory: clerk,
});

/** Another HTTP request: fresh services over the same database and infra, which keep no memory of the first. */
const freshRequest = (): Composed => composeWith({ db, infra });

beforeEach(async () => {
  db = migrated([ORG]);
  nowMs = Date.parse("2026-10-16T10:00:00.000Z");
  deferred = [];
  dropDeferred = false;
  failAtomic = false;
  slackCalls = [];
  slackEmail = "newcomer@example.com";
  slackUserTeam = "T0TEAM";
  downloadStatus = OK;
  statusAnswer = { ok: true };
  postSeq = 100;
  postAnswer = () => null;
  outOfChannel = new Set();
  directory = { emailOwner: null, member: false };
  infra = testInfra();
  composed = freshRequest();
  const workspace = await composed.services.workspaces.forOrg({
    clerkOrgId: ORG,
  });
  if (!workspace) {
    throw new Error("the test organisation is not allowed");
  }
  workspaceId = workspace.id;
  const owner = {
    kind: "user",
    userId: "user_owner",
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
  ({ machineId } = machine);
  agentId = (
    await composed.services.agents.create(owner, {
      machineId: machine.machineId,
      model: "m",
      name: "Bruce",
      runtime: "machine",
    })
  ).id;
  await installApp(agentId);
  await db.insert(identityLinks).values({
    clerkUserId: DOM,
    createdAt: new Date(nowMs).toISOString(),
    email: "dom@example.com",
    externalUserId: "U0DOM",
    id: "link_dom",
    provider: "slack",
    teamId: "T0TEAM",
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
        if (!dropDeferred) {
          deferred.push(job);
        }
      },
    })
  );
  app.onError((_error, c) => c.text("error", SERVER_ERROR));
});

/** Points the app row at `forAgent`, creating it on the first call. */
const installApp = async (forAgent: string) => {
  await db.delete(slackApps);
  const key = await importSecretsKey(SECRETS_KEY);
  const row = { id: "app_row_1", workspaceId };
  await db.insert(slackApps).values({
    agentId: forAgent,
    appId: "A0APP",
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
    teamId: "T0TEAM",
    workspaceId,
  });
};

const send = async (
  body: Fixture,
  options: { secret?: string; signature?: string; timestamp?: string } = {}
) => {
  const text = JSON.stringify(body);
  const timestamp = options.timestamp ?? String(Math.floor(nowMs / 1000));
  const signature =
    options.signature ??
    (await signSlackBody({
      body: text,
      signingSecret: options.secret ?? SECRET,
      timestamp,
    }));
  return await app.request("/api/slack/events", {
    body: text,
    headers: {
      "Content-Type": "application/json",
      "X-Slack-Request-Timestamp": timestamp,
      "X-Slack-Signature": signature,
    },
    method: "POST",
  });
};

const runAfterJobs = async () => {
  const jobs = deferred.splice(0);
  await Promise.all(jobs.map((job) => job()));
};

const allRuns = () => db.select().from(runRows).all();
const allSeen = () => db.select().from(slackEventsSeen).all();
const refusals = () =>
  db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "slack.event_refused"))
    .orderBy(asc(eventRows.id))
    .all()
    .map((row) => ({
      agentId: row.agentId,
      payload: JSON.parse(row.payload ?? "null") as unknown,
      workspaceId: row.workspaceId,
    }));
const refusedReasons = () =>
  refusals()
    .map((row) => (row.payload as { reason: string }).reason)
    .sort();
const eventTypes = () =>
  db
    .select({ type: eventRows.type })
    .from(eventRows)
    .orderBy(asc(eventRows.id))
    .all()
    .map((row) => row.type)
    .filter((type) => !type.startsWith("agent."));

test("a mention from a linked user creates the run with its session key and requester before the answer", async () => {
  const response = await send(await fixture("mention"));

  expect(response.status).toBe(OK);
  const [run, ...others] = allRuns();
  expect(others).toEqual([]);
  expect(await response.json()).toEqual({ ok: true, runId: run?.id });
  expect(run).toMatchObject({
    agentId,
    onBehalfOfUserId: DOM,
    pendingFiles: null,
    status: "queued",
  });
  expect(JSON.parse(run?.reply ?? "null")).toEqual({
    channel: "C0CHAN",
    kind: "slack",
    teamId: "T0TEAM",
    threadTs: "1789171201.000100",
  });
  const [session] = db.select().from(sessionRows).all();
  expect(session).toMatchObject({
    externalKey: "T0TEAM:C0CHAN:1789171201.000100",
    origin: "slack",
  });
  expect(run?.inputText).toBe("what is the status of the launch?");
  expect(allSeen()).toMatchObject([{ runId: run?.id }]);
  expect(eventTypes()).toEqual(
    expect.arrayContaining(["message.user", "run.queued", "slack.received"])
  );
  // The run and its events are written; offering it comes after the answer.
  expect(deferred).toHaveLength(1);
  await runAfterJobs();
  expect(allRuns()[0]?.status).toBe("offered");
});

test("a DM is keyed by its own timestamp and a threaded mention by its thread", async () => {
  await send(await fixture("dm"));
  const threaded = await fixture("mention");
  threaded.event_id = "Ev0THREADED1";
  threaded.event.thread_ts = "1789171100.000050";
  await send(threaded);

  expect(
    db
      .select()
      .from(sessionRows)
      .all()
      .map((s) => s.externalKey)
      .sort()
  ).toEqual([
    "T0TEAM:C0CHAN:1789171100.000050",
    "T0TEAM:D0DM:1789171202.000200",
  ]);
});

const namedLabels = () =>
  db
    .select({ payload: eventRows.payload })
    .from(eventRows)
    .where(eq(eventRows.type, "slack.named"))
    .all()
    .map(
      (row) => (JSON.parse(row.payload ?? "{}") as { label?: string }).label
    );

test("a channel mention records the channel name for the session title after the answer", async () => {
  await send(await fixture("mention"));
  expect(namedLabels()).toEqual([]);

  await runAfterJobs();

  expect(namedLabels()).toEqual(["#launch"]);
});

test("a DM records who it is with", async () => {
  await send(await fixture("dm"));

  await runAfterJobs();

  expect(namedLabels()).toEqual(["DM with Newcomer"]);
});

test("a failed name lookup writes no name and does not stop the run being offered", async () => {
  const gone = await fixture("mention");
  gone.event.channel = "C0GONE";
  await send(gone);

  await runAfterJobs();

  expect(namedLabels()).toEqual([]);
  expect(allRuns()[0]?.status).toBe("offered");
});

test("a DM starts a private session and a channel mention does not", async () => {
  await send(await fixture("dm"));
  await send(await fixture("mention"));

  const privacy = Object.fromEntries(
    db
      .select()
      .from(sessionRows)
      .all()
      .map((s) => [s.externalKey, s.private])
  );
  expect(privacy).toEqual({
    "T0TEAM:C0CHAN:1789171201.000100": false,
    "T0TEAM:D0DM:1789171202.000200": true,
  });
});

test("a retry with the same body creates nothing and still answers 200", async () => {
  const body = await fixture("mention");
  await send(body);
  const retry = await send(body);

  expect(retry.status).toBe(OK);
  expect(allRuns()).toHaveLength(1);
  expect(allSeen()).toHaveLength(1);
});

test("two events for one message create one run", async () => {
  const first = await fixture("dm");
  const second = await fixture("dm");
  second.event_id = "Ev0SECONDONE";
  await send(first);
  await send(second);

  expect(allRuns()).toHaveLength(1);
});

test("a mention to a paused agent starts no run, answers 200, and replies once in the thread", async () => {
  await db
    .update(agentRows)
    .set({ pausedAt: new Date(nowMs).toISOString(), pausedReason: "spend_cap" })
    .where(eq(agentRows.id, agentId));
  const body = await fixture("mention");

  const first = await send(body);
  expect(first.status).toBe(OK);
  expect(allRuns()).toHaveLength(0);
  await runAfterJobs();
  const posts = () =>
    slackCalls.filter((call) => call.method === "chat.postMessage");
  expect(posts()).toHaveLength(1);
  expect(posts()[0]?.body).toMatchObject({
    channel: "C0CHAN",
    text: "Bruce is paused. Its weekly limit was reached.",
    thread_ts: "1789171201.000100",
  });

  const second = await send(body);
  expect(second.status).toBe(OK);
  await runAfterJobs();
  expect(posts()).toHaveLength(1);
  expect(allRuns()).toHaveLength(0);
});

test("an app that is not installed yet is 401", async () => {
  await db.update(slackApps).set({ status: "created" });

  expect((await send(await fixture("mention"))).status).toBe(UNAUTHORIZED);
});

test("a bad signature is 401 and creates nothing", async () => {
  const body = await fixture("mention");
  const forged = await send(body, { secret: "not-the-secret" });
  const malformed = await send(body, { signature: "v0=00" });
  const stale = await send(body, {
    timestamp: String(Math.floor(nowMs / 1000) - 10 * 60),
  });

  expect([forged.status, malformed.status, stale.status]).toEqual([
    UNAUTHORIZED,
    UNAUTHORIZED,
    UNAUTHORIZED,
  ]);
  expect(allRuns()).toHaveLength(0);
  expect(allSeen()).toHaveLength(0);
});

test("an unknown or revoked app is 401", async () => {
  const unknown = await fixture("mention");
  unknown.api_app_id = "A0OTHER";
  expect((await send(unknown)).status).toBe(UNAUTHORIZED);

  await db.update(slackApps).set({ status: "revoked" });
  expect((await send(await fixture("mention"))).status).toBe(UNAUTHORIZED);
});

test("a team_id that does not match the app row is 401 even when the signature is right", async () => {
  const body = await fixture("mention");
  body.team_id = "T0OTHER";

  expect((await send(body)).status).toBe(UNAUTHORIZED);
  expect(allRuns()).toHaveLength(0);
});

test("a bad signature from a known app writes one refusal, and a repeat in the window writes none", async () => {
  const body = await fixture("mention");
  const signature = `v0=${"f".repeat(64)}`;
  const first = await send(body, { signature });
  const second = await send(body, { signature });

  expect([first.status, second.status]).toEqual([UNAUTHORIZED, UNAUTHORIZED]);
  const written = refusals();
  expect(written).toEqual([
    {
      agentId,
      payload: { appId: "A0APP", reason: "signature" },
      workspaceId,
    },
  ]);
  const json = JSON.stringify(db.select().from(eventRows).all());
  expect(json).not.toContain(SECRET);
  expect(json).not.toContain(signature);
  expect(json).not.toContain("what is the status of the launch?");
});

test("a team mismatch with a correct signature writes a team refusal, and a bad signature in the same minute still writes its own", async () => {
  const body = await fixture("mention");
  body.team_id = "T0OTHER";
  await send(body);
  await send(body);
  expect(refusedReasons()).toEqual(["team"]);

  await send(await fixture("mention"), { secret: "not-the-secret" });
  expect(refusedReasons()).toEqual(["signature", "team"]);
  expect(allRuns()).toHaveLength(0);
});

test("an unknown app id writes no event and logs a warning with the app id", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const unknown = await fixture("mention");
    unknown.api_app_id = "A0OTHER";
    expect((await send(unknown)).status).toBe(UNAUTHORIZED);

    expect(refusals()).toEqual([]);
    expect(warn.mock.calls).toEqual([
      ["Slack event refused: unknown app", "A0OTHER"],
    ]);
  } finally {
    warn.mockRestore();
  }
});

test("a refusal is written again once the window has passed", async () => {
  setSystemTime(new Date(nowMs));
  try {
    const signature = `v0=${"e".repeat(64)}`;
    await send(await fixture("mention"), { signature });
    expect(refusedReasons()).toEqual(["signature"]);

    nowMs += 11 * MINUTE_MS;
    setSystemTime(new Date(nowMs));
    await send(await fixture("mention"), { signature });

    expect(refusedReasons()).toEqual(["signature", "signature"]);
  } finally {
    setSystemTime();
  }
});

test("a bot's own message is ignored", async () => {
  const response = await send(await fixture("bot-message"));

  expect(response.status).toBe(OK);
  expect(allRuns()).toHaveLength(0);
  expect(allSeen()).toHaveLength(0);
});

/** An event the app is not subscribed to answer: a signed body, no handler. */
const unhandledEvent = (type: string, event: Record<string, unknown>) => ({
  api_app_id: "A0APP",
  event: { type, ...event },
  event_id: `Ev0${type.toUpperCase().replace("_", "")}01`,
  event_time: 1_789_171_200,
  team_id: "T0TEAM",
  type: "event_callback",
});

test("an app_home_opened event answers 200 and starts nothing", async () => {
  const eventsBefore = db.select().from(eventRows).all();
  const response = await send(
    unhandledEvent("app_home_opened", {
      channel: "D0DM",
      event_ts: "1789171200.000100",
      tab: "messages",
      user: "U0DOM",
    })
  );

  expect(response.status).toBe(OK);
  expect(await response.json()).toEqual({ ok: true });
  expect(allRuns()).toHaveLength(0);
  expect(allSeen()).toHaveLength(0);
  expect(db.select().from(eventRows).all()).toEqual(eventsBefore);
  expect(deferred).toHaveLength(0);
  expect(slackCalls).toEqual([]);
});

test("a team_join event answers 200 and starts nothing", async () => {
  const eventsBefore = db.select().from(eventRows).all();
  const response = await send(
    unhandledEvent("team_join", {
      event_ts: "1789171200.000100",
      user: { id: "U0NEW", name: "newcomer" },
    })
  );

  expect(response.status).toBe(OK);
  expect(await response.json()).toEqual({ ok: true });
  expect(allRuns()).toHaveLength(0);
  expect(allSeen()).toHaveLength(0);
  expect(db.select().from(eventRows).all()).toEqual(eventsBefore);
  expect(deferred).toHaveLength(0);
  expect(slackCalls).toEqual([]);
});

test("an unsigned app_home_opened event is 401, like other events", async () => {
  const response = await send(
    unhandledEvent("app_home_opened", {
      channel: "D0DM",
      event_ts: "1789171200.000100",
      tab: "messages",
      user: "U0DOM",
    }),
    { signature: "v0=00" }
  );

  expect(response.status).toBe(UNAUTHORIZED);
  expect(allRuns()).toHaveLength(0);
  expect(slackCalls).toEqual([]);
});

test("the URL check echoes the challenge, and junk is 400", async () => {
  const challenge = await app.request("/api/slack/events", {
    body: JSON.stringify(await fixture("url-verification")),
    method: "POST",
  });
  expect(await challenge.text()).toBe(
    "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P"
  );

  const junk = await app.request("/api/slack/events", {
    body: "{not json",
    method: "POST",
  });
  expect(junk.status).toBe(400);

  const huge = await app.request("/api/slack/events", {
    body: "x".repeat(300_000),
    method: "POST",
  });
  expect(huge.status).toBe(413);
});

test("an unlinked sender gets no run, a slack.unlinked_sender event, and is told to ask for access", async () => {
  const body = await fixture("dm");
  body.event.user = "U0NEW";
  const response = await send(body);

  expect(response.status).toBe(OK);
  expect(allRuns()).toHaveLength(0);
  expect(eventTypes()).toEqual(["slack.unlinked_sender"]);
  expect(allSeen()).toMatchObject([{ runId: null }]);

  await runAfterJobs();
  const post = slackCalls.find((call) => call.method === "chat.postMessage");
  expect(post?.body).toMatchObject({
    channel: "D0DM",
    text: UNLINKED_TEXT,
    thread_ts: "1789171202.000200",
  });
  expect(String(post?.body.text)).not.toContain("Dom");
  expect(post?.auth).toBe(`Bearer ${BOT_TOKEN}`);
  expect(db.select().from(identityLinks).all()).toHaveLength(1);
});

test("an unlinked sender whose Slack email is hidden is told to make it visible, and no link is made", async () => {
  slackEmail = null;
  directory = { emailOwner: "user_new", member: true };
  const body = await fixture("dm");
  body.event.user = "U0NEW";
  const response = await send(body);

  expect(response.status).toBe(OK);
  expect(allRuns()).toHaveLength(0);
  expect(db.select().from(identityLinks).all()).toHaveLength(1);
  expect(eventTypes()).toEqual(["slack.unlinked_sender"]);

  await runAfterJobs();
  const post = slackCalls.find((call) => call.method === "chat.postMessage");
  expect(post?.body).toMatchObject({
    channel: "D0DM",
    text: HIDDEN_EMAIL_TEXT,
    thread_ts: "1789171202.000200",
  });
  expect(String(post?.body.text)).not.toContain("Dom");
});

test("an email match for a Clerk user outside the org creates no link", async () => {
  directory = { emailOwner: "user_outsider", member: false };
  const body = await fixture("dm");
  body.event.user = "U0NEW";
  await send(body);
  await runAfterJobs();

  expect(db.select().from(identityLinks).all()).toHaveLength(1);
  expect(
    slackCalls.find((call) => call.method === "chat.postMessage")?.body.text
  ).toBe(UNLINKED_TEXT);
});

test("an email match for an org member creates the link and asks them to send again", async () => {
  directory = { emailOwner: "user_new", member: true };
  const body = await fixture("dm");
  body.event.user = "U0NEW";
  await send(body);
  await runAfterJobs();

  const links = db.select().from(identityLinks).all();
  expect(links).toHaveLength(2);
  expect(links.find((link) => link.externalUserId === "U0NEW")).toMatchObject({
    clerkUserId: "user_new",
    email: "newcomer@example.com",
    teamId: "T0TEAM",
  });
  expect(
    String(
      slackCalls.find((call) => call.method === "chat.postMessage")?.body.text
    )
  ).toContain("send your message again");

  const again = await fixture("dm");
  again.event.user = "U0NEW";
  again.event_id = "Ev0AGAIN0001";
  again.event.ts = "1789171400.000100";
  await send(again);
  expect(allRuns()).toMatchObject([{ onBehalfOfUserId: "user_new" }]);
});

test("a failure in the atomic write answers 500 and leaves no dedupe row, so the retry works", async () => {
  failAtomic = true;
  const body = await fixture("mention");
  const failed = await send(body);

  expect(failed.status).toBe(SERVER_ERROR);
  expect(allSeen()).toHaveLength(0);
  expect(allRuns()).toHaveLength(0);

  failAtomic = false;
  expect((await send(body)).status).toBe(OK);
  expect(allRuns()).toHaveLength(1);
});

test("a message with a file is not claimable until the download job has run", async () => {
  const response = await send(await fixture("dm-file"));
  const { runId } = (await response.json()) as { runId: string };

  const [pending] = allRuns();
  expect(JSON.parse(pending?.pendingFiles ?? "null")).toEqual([
    {
      id: "F0PDF",
      mimetype: "application/pdf",
      name: "plan.pdf",
      size: 12_345,
      teamId: "T0TEAM",
      url: PDF_URL,
    },
  ]);
  await expect(
    composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId)
  ).rejects.toMatchObject({ code: "conflict" });

  await runAfterJobs();
  const [fetched] = allRuns();
  const [file] = db.select().from(fileRows).all();
  expect(file).toMatchObject({
    createdById: DOM,
    mime: "application/pdf",
    name: "plan.pdf",
    source: "slack",
  });
  expect(fetched).toMatchObject({
    inputFileIds: JSON.stringify([file?.id]),
    pendingFiles: null,
  });
  expect(slackCalls.find((call) => call.method === "download")?.auth).toBe(
    `Bearer ${BOT_TOKEN}`
  );
  expect(
    await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId)
  ).toMatchObject({ status: "running" });
});

test("a file a run wrote to its task folder is uploaded to the thread after the answer", async () => {
  const { runId } = (await (await send(await fixture("dm-file"))).json()) as {
    runId: string;
  };
  await runAfterJobs();
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId);

  const runPrincipal = {
    agentId,
    kind: "run",
    runId,
    workspaceId,
  } as const;
  await composed.services.library.write(
    runPrincipal,
    `${taskFolderPath("bruce", runId)}/${SUMMARY_NAME}`,
    new TextEncoder().encode(SUMMARY_CONTENT)
  );
  await composed.services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    status: "done",
    text: SUMMARY_TEXT,
  });
  await runAfterJobs();

  const outbound = slackCalls.filter((call) =>
    [
      "chat.postMessage",
      "files.getUploadURLExternal",
      "upload",
      "files.completeUploadExternal",
    ].includes(call.method)
  );
  expect(outbound.map((call) => call.method)).toEqual([
    "chat.postMessage",
    "files.getUploadURLExternal",
    "upload",
    "files.completeUploadExternal",
  ]);
  const [post, getUploadUrl, upload, complete] = outbound;
  expect(post?.body).toMatchObject({
    channel: "D0DM",
    text: SUMMARY_TEXT,
    thread_ts: DM_FILE_THREAD_TS,
  });
  expect(getUploadUrl?.query).toMatchObject({
    filename: SUMMARY_NAME,
    length: String(new TextEncoder().encode(SUMMARY_CONTENT).byteLength),
  });
  expect(upload).toMatchObject({ auth: null, text: SUMMARY_CONTENT });
  expect(complete?.body).toMatchObject({
    channel_id: "D0DM",
    files: [{ id: OUTPUT_FILE_ID, title: SUMMARY_NAME }],
    thread_ts: DM_FILE_THREAD_TS,
  });

  const delivered = db
    .select({ payload: eventRows.payload })
    .from(eventRows)
    .where(eq(eventRows.type, "slack.delivered"))
    .all()
    .map((row) => JSON.parse(row.payload ?? "null"));
  expect(delivered).toEqual([expect.objectContaining({ delivered: true })]);
});

test("a process lost between the 200 and the download leaves the files for the sweep", async () => {
  dropDeferred = true;
  const response = await send(await fixture("dm-file"));
  const { runId } = (await response.json()) as { runId: string };

  expect(response.status).toBe(OK);
  expect(allRuns()[0]?.pendingFiles).not.toBeNull();
  nowMs += 2 * MINUTE_MS;
  const swept = await composed.services.runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);

  expect(swept.downloaded).toEqual([runId]);
  expect(allRuns()[0]?.pendingFiles).toBeNull();
  expect(db.select().from(fileRows).all()).toHaveLength(1);
  expect(
    await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId)
  ).toMatchObject({ status: "running" });
});

test("a download that keeps failing fails the run after three attempts", async () => {
  // The first attempt logs its failure, which this test expects.
  const log = spyOn(console, "error").mockImplementation(() => undefined);
  downloadStatus = 503;
  const response = await send(await fixture("dm-file"));
  const { runId } = (await response.json()) as { runId: string };

  await runAfterJobs();
  expect(allRuns()[0]).toMatchObject({ pendingAttempts: 1, status: "queued" });
  for (const _ of [1, 2]) {
    nowMs += 2 * MINUTE_MS;
    // biome-ignore lint/performance/noAwaitInLoops: the attempts follow one another
    await composed.services.runs.sweepQueuedRuns(SYSTEM_PRINCIPAL);
  }

  expect(allRuns()[0]).toMatchObject({ pendingAttempts: 3, status: "failed" });
  expect(
    db
      .select()
      .from(eventRows)
      .where(eq(eventRows.runId, runId))
      .all()
      .map((row) => row.type)
  ).toContain("run.failed");
  log.mockRestore();
});

test("the answer of a finished run is posted in the thread", async () => {
  const fake = await composed.services.agents.create(
    {
      kind: "user",
      userId: "user_owner",
      via: "session",
      workspaceId,
    },
    { model: "fake", name: "Echo", runtime: "fake" }
  );
  await installApp(fake.id);
  await send(await fixture("mention"));
  await runAfterJobs();

  const post = slackCalls.find((call) => call.method === "chat.postMessage");
  expect(post?.body).toMatchObject({
    channel: "C0CHAN",
    thread_ts: "1789171201.000100",
  });
  expect(String(post?.body.text)).toContain(
    "what is the status of the launch?"
  );
  expect(eventTypes()).toContain("slack.delivered");
});

const AGENT_THREAD_TS = "1789171100.000050";
const REPLY_TS = "1789171500.000100";
const DM_THREAD_TS = "1789171202.000300";

/** A ui session of Dom's that the agent started a Slack thread from. */
const startedThread = async (channelId: string, threadTs: string) => {
  const { sessionId } = await composed.services.runs.startRun(
    { kind: "user", userId: DOM, via: "session", workspaceId },
    {
      agentId,
      input: { text: "post the update" },
      session: { origin: "ui" },
    }
  );
  await db.insert(slackThreads).values({
    agentId,
    channelId,
    createdAt: new Date(nowMs).toISOString(),
    id: `thread_${threadTs}`,
    sessionId,
    teamId: "T0TEAM",
    threadTs,
    workspaceId,
  });
  return sessionId;
};

/** A message in a channel thread with no mention, as Slack sends it. */
const channelReply = async (
  threadTs: string | undefined,
  ts: string,
  user = "U0DOM"
) => {
  const body = await fixture("dm");
  body.event_id = `Ev${ts}`;
  body.event = {
    ...body.event,
    channel: "C0CHAN",
    channel_type: "channel",
    text: "any update?",
    ts,
    user,
  };
  if (threadTs) {
    body.event.thread_ts = threadTs;
  }
  return body;
};

const runsWithText = (text: string) =>
  allRuns().filter((run) => run.inputText === text);

test("a reply in a thread the agent started continues that session and answers in the thread", async () => {
  const sessionId = await startedThread("C0CHAN", AGENT_THREAD_TS);
  const response = await send(await channelReply(AGENT_THREAD_TS, REPLY_TS));

  expect(response.status).toBe(OK);
  const [run] = runsWithText("any update?");
  expect(run).toMatchObject({ sessionId, onBehalfOfUserId: DOM });
  expect(JSON.parse(run?.reply ?? "null")).toEqual({
    channel: "C0CHAN",
    kind: "slack",
    teamId: "T0TEAM",
    threadTs: AGENT_THREAD_TS,
  });
  expect(allSeen()).toHaveLength(1);
});

test("a channel reply in a thread the app does not know starts nothing", async () => {
  const response = await send(
    await channelReply("1789171000.000010", REPLY_TS)
  );

  expect(response.status).toBe(OK);
  expect(allRuns()).toHaveLength(0);
  expect(allSeen()).toHaveLength(0);
});

test("a reply in a thread a mention started continues that Slack session", async () => {
  await send(await fixture("mention"));
  await send(await channelReply("1789171201.000100", REPLY_TS));

  expect(allRuns()).toHaveLength(2);
  expect(new Set(allRuns().map((run) => run.sessionId)).size).toBe(1);
  expect(db.select().from(sessionRows).all()).toHaveLength(1);
});

test("an unlinked person's reply in a known thread gets no run, no row and no Slack post", async () => {
  await startedThread("C0CHAN", AGENT_THREAD_TS);
  const response = await send(
    await channelReply(AGENT_THREAD_TS, REPLY_TS, "U0NEW")
  );
  await runAfterJobs();

  expect(response.status).toBe(OK);
  expect(runsWithText("any update?")).toHaveLength(0);
  expect(allSeen()).toHaveLength(0);
  expect(eventTypes()).not.toContain("slack.unlinked_sender");
  expect(
    slackCalls.filter((call) => call.method === "chat.postMessage")
  ).toEqual([]);
});

/** A second linked person, who is not the owner of the agent's ui session. */
const linkSecondPerson = () =>
  db
    .insert(identityLinks)
    .values({
      clerkUserId: "user_eve",
      createdAt: new Date(nowMs).toISOString(),
      email: "eve@example.com",
      externalUserId: "U0EVE",
      id: "link_eve",
      provider: "slack",
      teamId: "T0TEAM",
      workspaceId,
    })
    .run();

test("another linked person's plain reply in a thread started from a ui session starts nothing", async () => {
  await startedThread("C0CHAN", AGENT_THREAD_TS);
  await linkSecondPerson();
  const response = await send(
    await channelReply(AGENT_THREAD_TS, REPLY_TS, "U0EVE")
  );

  expect(response.status).toBe(OK);
  expect(runsWithText("any update?")).toHaveLength(0);
  expect(allSeen()).toHaveLength(0);
});

test("another linked person's mention in a thread started from a ui session opens its own Slack session", async () => {
  const uiSession = await startedThread("C0CHAN", AGENT_THREAD_TS);
  await linkSecondPerson();
  const mention = await fixture("mention");
  mention.event_id = "Ev0EVEMENTION";
  mention.event = {
    ...mention.event,
    thread_ts: AGENT_THREAD_TS,
    ts: REPLY_TS,
    user: "U0EVE",
  };
  const response = await send(mention);

  expect(response.status).toBe(OK);
  const eveRuns = allRuns().filter(
    (run) => run.onBehalfOfUserId === "user_eve"
  );
  expect(eveRuns).toHaveLength(1);
  expect(eveRuns[0]?.sessionId).not.toBe(uiSession);
});

test("a bot's own message and another bot's message in a known thread start no run", async () => {
  await startedThread("C0CHAN", AGENT_THREAD_TS);
  const own = await channelReply(AGENT_THREAD_TS, REPLY_TS, "U0BOT");
  own.event.bot_id = "B0BOT";
  own.event.app_id = "A0APP";
  const other = await channelReply(
    AGENT_THREAD_TS,
    "1789171600.000100",
    "U0OTHER"
  );
  other.event.bot_id = "B0OTHER";
  await send(own);
  await send(other);

  expect(runsWithText("any update?")).toHaveLength(0);
  expect(allSeen()).toHaveLength(0);
});

test("a thread reply that also mentions the app creates one run in either delivery order", async () => {
  const sessionId = await startedThread("C0CHAN", AGENT_THREAD_TS);
  const asMessage = await channelReply(AGENT_THREAD_TS, REPLY_TS);
  asMessage.event.text = "<@U0BOT> any update?";
  const asMention = await fixture("mention");
  asMention.event_id = "Ev0REPLYMENTION";
  asMention.event.thread_ts = AGENT_THREAD_TS;
  asMention.event.ts = REPLY_TS;

  await send(asMessage);
  await send(asMention);
  const runs = runsWithText("any update?");
  expect(runs.map((run) => run.sessionId)).toEqual([sessionId]);
  expect(allSeen()).toHaveLength(1);
});

test("the same thread reply sent as a mention first also creates one run", async () => {
  await startedThread("C0CHAN", AGENT_THREAD_TS);
  const asMention = await fixture("mention");
  asMention.event_id = "Ev0REPLYMENTION";
  asMention.event.thread_ts = AGENT_THREAD_TS;
  asMention.event.ts = REPLY_TS;
  const asMessage = await channelReply(AGENT_THREAD_TS, REPLY_TS);
  asMessage.event.text = "<@U0BOT> any update?";

  await send(asMention);
  await send(asMessage);

  expect(
    allRuns().filter(
      (run) => run.inputText === "what is the status of the launch?"
    )
  ).toHaveLength(1);
  expect(allSeen()).toHaveLength(1);
});

test("a plain top-level channel message is still ignored", async () => {
  const response = await send(await channelReply(undefined, REPLY_TS));

  expect(response.status).toBe(OK);
  expect(allRuns()).toHaveLength(0);
  expect(allSeen()).toHaveLength(0);
});

test("a DM reply in a thread the agent started in the DM continues the session", async () => {
  const sessionId = await startedThread("D0DM", DM_THREAD_TS);
  const reply = await fixture("dm");
  reply.event_id = "Ev0DMREPLY01";
  reply.event.thread_ts = DM_THREAD_TS;
  reply.event.ts = REPLY_TS;
  reply.event.text = "any update?";
  await send(reply);

  const [run] = runsWithText("any update?");
  expect(run).toMatchObject({ sessionId });
  expect(JSON.parse(run?.reply ?? "null")).toMatchObject({
    channel: "D0DM",
    threadTs: DM_THREAD_TS,
  });
  expect(db.select().from(sessionRows).all()).toHaveLength(1);
});

const DM_TS = "1789171202.000200";
const DM_CHANNEL = "D0DM";
/** The linked DM sender, who started the run and may cancel it. */
const domPrincipal = () => ({
  kind: "user" as const,
  userId: DOM,
  via: "session" as const,
  workspaceId,
});

const statusCalls = () =>
  slackCalls.filter((call) => call.method === STATUS_METHOD);

/** Sends the linked DM and runs its jobs, which show "is thinking…". */
const startDmRun = async (): Promise<string> => {
  const response = await send(await fixture("dm"));
  const { runId } = (await response.json()) as { runId: string };
  await runAfterJobs();
  return runId;
};

/** Reports one tool call of a run that the machine has claimed. */
const reportTool = (
  runId: string,
  seq: number,
  name: string,
  services: Composed["services"] = composed.services
) =>
  services.runs.ingestRunEvents(SYSTEM_PRINCIPAL, runId, [
    {
      payload: { input: {}, name, toolUseId: `t${seq}` },
      seq,
      type: "tool.call",
    },
  ]);

test("a DM from a linked user shows 'is thinking…' in its thread with the bot token", async () => {
  await startDmRun();

  expect(statusCalls()).toMatchObject([
    {
      auth: `Bearer ${BOT_TOKEN}`,
      body: {
        channel_id: DM_CHANNEL,
        status: "is thinking…",
        thread_ts: DM_TS,
      },
    },
  ]);
});

test("a bash tool call six seconds later says it runs a command, and a read within five seconds adds no call", async () => {
  const runId = await startDmRun();
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  nowMs += 6 * SECOND_MS;
  await reportTool(runId, 1, "bash");

  expect(statusCalls()).toHaveLength(2);
  expect(statusCalls()[1]?.body).toMatchObject({
    channel_id: DM_CHANNEL,
    status: "is running a command…",
    thread_ts: DM_TS,
  });

  nowMs += 2 * SECOND_MS;
  await reportTool(runId, 2, "read");
  expect(statusCalls()).toHaveLength(2);
});

test("cancelling the run clears the status with an empty one", async () => {
  const runId = await startDmRun();
  await composed.services.runs.cancelRun(domPrincipal(), runId);

  expect(statusCalls().slice(1)).toMatchObject([
    { body: { channel_id: DM_CHANNEL, status: "", thread_ts: DM_TS } },
  ]);
});

test("a failed run clears the status with an empty one", async () => {
  const runId = await startDmRun();
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await composed.services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    error: "boom",
    status: "failed",
  });

  expect(statusCalls().slice(1)).toMatchObject([
    { body: { channel_id: DM_CHANNEL, status: "", thread_ts: DM_TS } },
  ]);
});

test("a done run posts its answer and sends no clearing status", async () => {
  const runId = await startDmRun();
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await composed.services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    status: "done",
    text: "All set.",
  });
  await runAfterJobs();

  expect(
    slackCalls.some(
      (call) =>
        call.method === "chat.postMessage" && call.body.text === "All set."
    )
  ).toBe(true);
  expect(statusCalls().map((call) => call.body.status)).toEqual([
    "is thinking…",
  ]);
});

test("a missing scope keeps the run, warns once, and sends no later status", async () => {
  statusAnswer = { error: "missing_scope", ok: false };
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const runId = await startDmRun();
  expect(allRuns()).toHaveLength(1);
  expect(["queued", "offered"]).toContain(allRuns()[0]?.status ?? "");

  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  nowMs += 6 * SECOND_MS;
  await reportTool(runId, 1, "bash");
  await composed.services.runs.cancelRun(domPrincipal(), runId);

  expect(statusCalls()).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("missing_scope");
  warn.mockRestore();
});

test("a method not supported for the channel is skipped quietly", async () => {
  statusAnswer = { error: "method_not_supported_for_channel_type", ok: false };
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const runId = await startDmRun();
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  nowMs += 6 * SECOND_MS;
  await reportTool(runId, 1, "bash");
  await composed.services.runs.cancelRun(domPrincipal(), runId);

  expect(statusCalls()).toHaveLength(1);
  expect(
    warn.mock.calls
      .map((args) => String(args[0]))
      .filter((text) => text.includes("Slack status"))
  ).toEqual([]);
  warn.mockRestore();
});

test("a run that did not come from Slack sends no status", async () => {
  const { runId } = await composed.services.runs.startRun(
    { kind: "user", userId: "user_owner", via: "session", workspaceId },
    { agentId, input: { text: "hi" }, session: { origin: "ui" } }
  );
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await reportTool(runId, 1, "bash");
  await composed.services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    status: "done",
    text: "ok",
  });
  await runAfterJobs();

  expect(statusCalls()).toEqual([]);
});

/** The `runs` row of a run, read back as the status facts the Slack status keeps on it. */
const runRow = (runId: string) =>
  db.select().from(runRows).where(eq(runRows.id, runId)).all()[0];

test("the 5 s limit holds across requests: a status claimed by one request limits the next", async () => {
  const runId = await startDmRun();
  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  nowMs += 6 * SECOND_MS;
  await reportTool(runId, 1, "bash");
  expect(statusCalls().map((call) => call.body.status)).toEqual([
    "is thinking…",
    "is running a command…",
  ]);

  nowMs += 2 * SECOND_MS;
  await reportTool(runId, 2, "read", freshRequest().services);
  expect(statusCalls()).toHaveLength(2);

  nowMs += 6 * SECOND_MS;
  await reportTool(runId, 3, "read", freshRequest().services);
  expect(statusCalls()).toHaveLength(3);
  expect(statusCalls()[2]?.body).toMatchObject({
    channel_id: DM_CHANNEL,
    status: "is reading files…",
    thread_ts: DM_TS,
  });
});

test("a missing scope stops the status for every request, so later calls from other requests send nothing", async () => {
  statusAnswer = { error: "missing_scope", ok: false };
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  const runId = await startDmRun();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0]?.[0])).toContain("missing_scope");
  expect(runRow(runId)?.slackStatusStopped).toBe(true);

  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  nowMs += 6 * SECOND_MS;
  await reportTool(runId, 1, "bash", freshRequest().services);
  await freshRequest().services.runs.cancelRun(domPrincipal(), runId);

  expect(statusCalls()).toHaveLength(1);
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test("cancelling from another request clears the status once, and a second terminal event adds no call", async () => {
  const runId = await startDmRun();
  await freshRequest().services.runs.cancelRun(domPrincipal(), runId);

  expect(statusCalls()).toHaveLength(2);
  expect(statusCalls()[1]?.body).toMatchObject({
    channel_id: DM_CHANNEL,
    status: "",
    thread_ts: DM_TS,
  });
  expect(runRow(runId)?.slackStatusStopped).toBe(true);

  await freshRequest().services.events.append({
    actor: { id: "system", kind: "system" },
    payload: {},
    runId,
    type: "run.failed",
    workspaceId,
  });
  expect(statusCalls()).toHaveLength(2);
});

test("a run that did not come from Slack keeps no status facts, whichever request handles its events", async () => {
  const { runId } = await composed.services.runs.startRun(
    { kind: "user", userId: "user_owner", via: "session", workspaceId },
    { agentId, input: { text: "hi" }, session: { origin: "ui" } }
  );
  await freshRequest().services.runs.claimRun(SYSTEM_PRINCIPAL, runId);
  await reportTool(runId, 1, "bash", freshRequest().services);
  await freshRequest().services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    error: "boom",
    status: "failed",
  });
  await runAfterJobs();

  expect(runRow(runId)).toMatchObject({
    slackStatusAt: null,
    slackStatusLabel: null,
    slackStatusStopped: false,
  });
  expect(statusCalls()).toEqual([]);
});

test("the Slack run row keeps the label and the clock time of the status it sent", async () => {
  const runId = await startDmRun();

  expect(runRow(runId)).toMatchObject({
    slackStatusAt: new Date(nowMs).toISOString(),
    slackStatusLabel: "is thinking…",
  });
});

// ---- Slack channel linked to a team room ----

const ROOM_CHANNEL = "C0ROOM";
const ROOM_OWNER = {
  kind: "user",
  userId: "user_owner",
  via: "session",
  workspaceId: "",
} as const;
const STRANGER = "U0STRANGER";
const ROOM_FIRST_TS = "1789172000.000100";

interface RoomApp {
  agentId: string;
  apiAppId: string;
  botUserId: string;
  slug: string;
}

let roomApps: RoomApp[];
let roomTeamId: string;

/** The first app keeps `BOT_TOKEN`, every other room app has a token of its own. */
const appToken = (apiAppId: string): string =>
  apiAppId === "A0APP" ? BOT_TOKEN : `xoxb-${apiAppId}`;

/** A Slack app row for an agent, signed with the same secret as the first app. */
const addApp = async (input: {
  agentId: string;
  apiAppId: string;
  botUserId: string;
}) => {
  const key = await importSecretsKey(SECRETS_KEY);
  const row = { id: `row_${input.apiAppId}`, workspaceId };
  await db.insert(slackApps).values({
    agentId: input.agentId,
    appId: input.apiAppId,
    botToken: await encryptSecret(
      key,
      slackSecretBinding(row, "bot_token"),
      appToken(input.apiAppId)
    ),
    botUserId: input.botUserId,
    createdAt: new Date(nowMs).toISOString(),
    id: row.id,
    signingSecret: await encryptSecret(
      key,
      slackSecretBinding(row, "signing_secret"),
      SECRET
    ),
    status: "installed",
    teamId: "T0TEAM",
    workspaceId,
  });
};

/**
 * Four member apps (Bruce, the lead, and three more) in the team "Ops", with
 * Dom in the team and the channel linked to its room.
 */
const setupRoom = async (options: { leadListens?: boolean } = {}) => {
  const owner = { ...ROOM_OWNER, workspaceId };
  roomApps = [
    { agentId, apiAppId: "A0APP", botUserId: "U0BOT", slug: "bruce" },
  ];
  for (const [index, name] of ["Ada", "Cy", "Di"].entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: three short setup steps, in order
    const agent = await composed.services.agents.create(owner, {
      machineId,
      model: "m",
      name,
      runtime: "machine",
    });
    roomApps.push({
      agentId: agent.id,
      apiAppId: `A0APP${index + 2}`,
      botUserId: `U0BOT${index + 2}`,
      slug: agent.slug,
    });
    await addApp({
      agentId: agent.id,
      apiAppId: `A0APP${index + 2}`,
      botUserId: `U0BOT${index + 2}`,
    });
  }
  const team = await composed.services.teams.create(owner, {
    leadAgentId: agentId,
    leadListens: options.leadListens ?? true,
    name: "Ops",
  });
  roomTeamId = team.id;
  for (const roomApp of roomApps) {
    // biome-ignore lint/performance/noAwaitInLoops: a few short setup steps, in order
    await composed.services.teams.addMember(owner, {
      memberId: roomApp.agentId,
      memberKind: "agent",
      teamId: team.id,
    });
  }
  await composed.services.teams.addMember(owner, {
    memberId: DOM,
    memberKind: "user",
    teamId: team.id,
  });
  await db.insert(teamSlackLinks).values({
    channelId: ROOM_CHANNEL,
    createdAt: new Date(nowMs).toISOString(),
    id: "link_room",
    linkedBy: "user_owner",
    slackTeamId: "T0TEAM",
    teamId: team.id,
    workspaceId,
  });
};

/** The event one app hears for a channel message. */
const roomEvent = (
  roomApp: Pick<RoomApp, "apiAppId">,
  message: {
    channel?: string;
    text: string;
    threadTs?: string;
    ts: string;
    user?: string;
  }
): Fixture => ({
  api_app_id: roomApp.apiAppId,
  event: {
    channel: message.channel ?? ROOM_CHANNEL,
    channel_type: "channel",
    text: message.text,
    thread_ts: message.threadTs,
    ts: message.ts,
    type: "message",
    user: message.user ?? "U0DOM",
  },
  event_id: `Ev-${roomApp.apiAppId}-${message.ts}`,
  team_id: "T0TEAM",
  type: "event_callback",
});

/** Every member app hears the message, as Slack delivers it. */
const sendToAllApps = async (message: Parameters<typeof roomEvent>[1]) => {
  for (const roomApp of roomApps) {
    // biome-ignore lint/performance/noAwaitInLoops: deliveries arrive one after another
    await send(roomEvent(roomApp, message));
  }
};

const roomPosts = () =>
  db.select().from(inboxPosts).orderBy(asc(inboxPosts.id)).all();
const roomTopics = () => db.select().from(inboxThreads).all();
const roomRows = () => db.select().from(slackRoomMessages).all();
const roomRunsBy = (slug: string) =>
  allRuns().filter(
    (run) => run.agentId === roomApps.find((a) => a.slug === slug)?.agentId
  );

test("four apps hear a message and the room records one post", async () => {
  await setupRoom();

  await sendToAllApps({ text: "Launch is on Friday.", ts: ROOM_FIRST_TS });
  // A retry of one app's delivery is dropped as well.
  await send(
    roomEvent(roomApps[1] as RoomApp, {
      text: "Launch is on Friday.",
      ts: ROOM_FIRST_TS,
    })
  );
  await runAfterJobs();

  expect(roomPosts()).toMatchObject([
    { authorId: DOM, authorKind: "user", text: "Launch is on Friday." },
  ]);
  expect(roomTopics()).toMatchObject([
    { teamId: roomTeamId, title: "Launch is on Friday." },
  ]);
  expect(roomRows()).toMatchObject([
    {
      channelId: ROOM_CHANNEL,
      direction: "in",
      postId: roomPosts()[0]?.id,
      threadTs: null,
      ts: ROOM_FIRST_TS,
    },
  ]);
  // Dom named nobody, so the lead hears it once.
  expect(allRuns()).toHaveLength(1);
});

test("a thread reply joins the topic of its thread and a top-level message opens a topic from its first line", async () => {
  await setupRoom({ leadListens: false });

  await sendToAllApps({
    text: "Budget review\nWe need the numbers by Monday.",
    ts: ROOM_FIRST_TS,
  });
  await sendToAllApps({
    text: "I will send them.",
    threadTs: ROOM_FIRST_TS,
    ts: "1789172001.000200",
  });
  await sendToAllApps({
    text: "Something else entirely",
    ts: "1789172002.000300",
  });
  // The parent of this thread is older than the link, so the reply opens a topic.
  await sendToAllApps({
    text: "Late reply",
    threadTs: "1789100000.000100",
    ts: "1789172003.000400",
  });

  const topics = roomTopics();
  expect(topics.map((t) => t.title).sort()).toEqual([
    "Budget review",
    "Late reply",
    "Something else entirely",
  ]);
  const budget = topics.find((t) => t.title === "Budget review");
  expect(
    roomPosts()
      .filter((p) => p.threadId === budget?.id)
      .map((p) => p.text)
  ).toEqual([
    "Budget review\nWe need the numbers by Monday.",
    "I will send them.",
  ]);
  expect(roomRows().find((r) => r.ts === "1789172001.000200")).toMatchObject({
    direction: "in",
    threadTs: ROOM_FIRST_TS,
  });
  expect(roomPosts()).toHaveLength(4);
});

test("an unknown Slack user posts as a named guest and wakes nobody", async () => {
  await setupRoom();

  await sendToAllApps({
    text: "<@U0BOT2> please help",
    ts: ROOM_FIRST_TS,
    user: STRANGER,
  });
  await runAfterJobs();

  expect(roomPosts()).toMatchObject([
    {
      authorId: `slack:T0TEAM:${STRANGER}`,
      authorKind: "user",
      guestName: "Newcomer",
      text: "@ada please help",
    },
  ]);
  expect(allRuns()).toEqual([]);
});

const roomEphemerals = () =>
  slackCalls.filter((call) => call.method === "chat.postEphemeral");

/** A Clerk user the directory finds by the newcomer's email, in the org and in the team. */
const addNewcomerToTeam = async () => {
  directory = { emailOwner: "user_new", member: true };
  await composed.services.teams.addMember(
    { ...ROOM_OWNER, workspaceId },
    { memberId: "user_new", memberKind: "user", teamId: roomTeamId }
  );
};

test("the first message of an unlinked team member posts as that person, links them and wakes the lead", async () => {
  await setupRoom();
  await addNewcomerToTeam();

  await sendToAllApps({
    text: "Launch is on Friday.",
    ts: ROOM_FIRST_TS,
    user: "U0NEW",
  });
  await runAfterJobs();

  expect(roomPosts()).toMatchObject([
    { authorId: "user_new", authorKind: "user", text: "Launch is on Friday." },
  ]);
  expect(
    db
      .select()
      .from(identityLinks)
      .all()
      .filter((link) => link.externalUserId === "U0NEW")
  ).toMatchObject([
    {
      clerkUserId: "user_new",
      email: "newcomer@example.com",
      teamId: "T0TEAM",
    },
  ]);
  expect(allRuns()).toHaveLength(1);
  expect(roomEphemerals()).toEqual([]);
  expect(eventTypes()).not.toContain("slack.unlinked_sender");
});

test("an unlinked Slack user who matches nobody stays a guest and is told once how to get linked", async () => {
  await setupRoom();

  await sendToAllApps({ text: "hello", ts: ROOM_FIRST_TS, user: STRANGER });
  await sendToAllApps({
    text: "anyone there?",
    ts: "1789172000.000200",
    user: STRANGER,
  });
  await runAfterJobs();

  expect(roomPosts()).toMatchObject([
    { authorId: `slack:T0TEAM:${STRANGER}` },
    { authorId: `slack:T0TEAM:${STRANGER}` },
  ]);
  expect(allRuns()).toEqual([]);
  expect(roomEphemerals()).toHaveLength(1);
  expect(roomEphemerals()[0]?.body).toMatchObject({
    channel: ROOM_CHANNEL,
    text: UNLINKED_TEXT,
    thread_ts: ROOM_FIRST_TS,
    user: STRANGER,
  });
  expect(roomEphemerals()[0]?.auth).toMatch(BEARER_TOKEN);
  expect(eventTypes().filter((t) => t === "slack.unlinked_sender")).toEqual([
    "slack.unlinked_sender",
  ]);
  expect(db.select().from(identityLinks).all()).toHaveLength(1);
});

test("a guest whose Slack email is hidden is told to make it visible", async () => {
  await setupRoom();
  slackEmail = null;

  await sendToAllApps({ text: "hello", ts: ROOM_FIRST_TS, user: STRANGER });
  await runAfterJobs();

  expect(roomEphemerals()).toHaveLength(1);
  expect(roomEphemerals()[0]?.body.text).toBe(HIDDEN_EMAIL_TEXT);
});

test("a Slack Connect user with a hidden email gets no reply either", async () => {
  await setupRoom();
  slackUserTeam = "T0OTHER";
  slackEmail = null;

  await sendToAllApps({
    text: "hi from outside",
    ts: ROOM_FIRST_TS,
    user: STRANGER,
  });
  await runAfterJobs();

  expect(roomPosts()).toMatchObject([{ authorId: `slack:T0TEAM:${STRANGER}` }]);
  expect(roomEphemerals()).toEqual([]);
});

test("a Slack Connect user from another organisation is not linked by email", async () => {
  await setupRoom();
  await addNewcomerToTeam();
  slackUserTeam = "T0OTHER";

  await sendToAllApps({
    text: "hi from outside",
    ts: ROOM_FIRST_TS,
    user: "U0NEW",
  });
  await runAfterJobs();

  expect(roomPosts()).toMatchObject([
    {
      authorId: "slack:T0TEAM:U0NEW",
      guestName: "Newcomer",
      text: "hi from outside",
    },
  ]);
  expect(allRuns()).toEqual([]);
  expect(db.select().from(identityLinks).all()).toHaveLength(1);
  expect(roomEphemerals()).toEqual([]);
});

test("a linked person who is not in the team posts as a guest", async () => {
  await setupRoom();
  await db.insert(identityLinks).values({
    clerkUserId: "user_outsider",
    createdAt: new Date(nowMs).toISOString(),
    email: "out@example.com",
    externalUserId: "U0OUT",
    id: "link_out",
    provider: "slack",
    teamId: "T0TEAM",
    workspaceId,
  });

  await sendToAllApps({ text: "hello", ts: ROOM_FIRST_TS, user: "U0OUT" });
  await runAfterJobs();

  expect(roomPosts()).toMatchObject([
    {
      authorId: "slack:T0TEAM:U0OUT",
      guestName: "Newcomer",
      text: "hello",
    },
  ]);
  expect(allRuns()).toEqual([]);
});

test("a mention of a member app wakes that agent through the room, not a Slack session", async () => {
  await setupRoom();

  await sendToAllApps({
    text: "<@U0BOT2> what is the status?",
    ts: ROOM_FIRST_TS,
  });
  // The mentioned app also hears it as an app mention.
  const mention = roomEvent(roomApps[1] as RoomApp, {
    text: "<@U0BOT2> what is the status?",
    ts: ROOM_FIRST_TS,
  });
  mention.event.type = "app_mention";
  await send(mention);
  await runAfterJobs();

  expect(roomPosts().map((p) => p.text)).toEqual(["@ada what is the status?"]);
  const [run, ...others] = allRuns();
  expect(others).toEqual([]);
  expect(run).toMatchObject({
    agentId: roomApps[1]?.agentId,
    onBehalfOfUserId: DOM,
  });
  expect(JSON.parse(run?.reply ?? "null")).toEqual({
    kind: "inbox",
    threadId: roomPosts()[0]?.threadId,
  });
  expect(db.select().from(sessionRows).all()).toMatchObject([
    { externalKey: roomPosts()[0]?.threadId, origin: "inbox" },
  ]);
  expect(allSeen()).toEqual([]);
  expect(roomRunsBy("bruce")).toEqual([]);
});

test("a message with no mention goes to the lead when lead_listens is on, and to nobody when it is off", async () => {
  await setupRoom();
  await sendToAllApps({ text: "anyone around?", ts: ROOM_FIRST_TS });
  await runAfterJobs();
  expect(roomRunsBy("bruce")).toHaveLength(1);
  expect(allRuns()).toHaveLength(1);

  await db
    .update(teamRows)
    .set({ leadListens: false })
    .where(eq(teamRows.id, roomTeamId));
  await sendToAllApps({ text: "hello again", ts: "1789172005.000500" });
  await runAfterJobs();

  expect(roomPosts()).toHaveLength(2);
  expect(allRuns()).toHaveLength(1);
});

test("a message from a member app is ignored, whichever way Slack labels it", async () => {
  await setupRoom();
  // SL.3 recorded this one when it sent it.
  await db.insert(inboxThreads).values({
    createdAt: new Date(nowMs).toISOString(),
    createdBy: "x",
    id: "th_out",
    lastPostAt: new Date(nowMs).toISOString(),
    teamId: roomTeamId,
    title: "sent",
    workspaceId,
  });
  await db.insert(inboxPosts).values({
    authorId: agentId,
    authorKind: "agent",
    createdAt: new Date(nowMs).toISOString(),
    id: "post_out",
    text: "sent from the room",
    threadId: "th_out",
    workspaceId,
  });
  await db.insert(slackRoomMessages).values({
    channelId: ROOM_CHANNEL,
    createdAt: new Date(nowMs).toISOString(),
    direction: "out",
    id: "row_out",
    postId: "post_out",
    slackTeamId: "T0TEAM",
    ts: "1789172100.000100",
    workspaceId,
  });

  // The echo of the recorded message, as a person's message would arrive.
  await sendToAllApps({
    text: "sent from the room",
    ts: "1789172100.000100",
    user: "U0BOT3",
  });
  // The echo as a bot message, and another member app's message with no bot fields.
  const echo = roomEvent(roomApps[1] as RoomApp, {
    text: "from a bot",
    ts: "1789172101.000100",
  });
  echo.event.bot_id = "B0OTHER";
  await send(echo);
  await sendToAllApps({
    text: "no bot fields",
    ts: "1789172102.000100",
    user: "U0BOT4",
  });
  await runAfterJobs();

  expect(roomPosts()).toHaveLength(1);
  expect(roomRows()).toHaveLength(1);
  expect(allRuns()).toEqual([]);
});

test("a channel with no link behaves as before", async () => {
  await setupRoom();

  const response = await send(await fixture("mention"));

  expect(response.status).toBe(OK);
  const [run, ...others] = allRuns();
  expect(others).toEqual([]);
  expect(run).toMatchObject({ agentId, onBehalfOfUserId: DOM });
  expect(db.select().from(sessionRows).all()).toMatchObject([
    { origin: "slack" },
  ]);
  expect(roomPosts()).toEqual([]);
  expect(roomRows()).toEqual([]);
  expect(roomTopics()).toEqual([]);
});

test("a write that loses the Slack message key leaves no post and no topic", async () => {
  await setupRoom();
  const write = () =>
    composed.services.inbox.postExternal({
      alongside: ({ postId }) => [
        db.insert(slackRoomMessages).values({
          channelId: ROOM_CHANNEL,
          createdAt: new Date(nowMs).toISOString(),
          direction: "in",
          id: `row_${postId}`,
          postId,
          slackTeamId: "T0TEAM",
          ts: ROOM_FIRST_TS,
          workspaceId,
        }),
      ],
      authorId: DOM,
      teamId: roomTeamId,
      text: "once",
      thread: { kind: "new", title: "once" },
      waker: null,
      workspaceId,
    });
  await write();

  await expect(write()).rejects.toThrow("UNIQUE");

  expect(roomPosts()).toHaveLength(1);
  expect(roomTopics()).toHaveLength(1);
  expect(roomRows()).toHaveLength(1);
});

// Room to Slack (SL.3): a post made in Agentum goes out to the linked channel.

const DOM_USER = {
  kind: "user",
  userId: DOM,
  via: "session",
  workspaceId: "",
} as const;

const postCalls = () =>
  slackCalls.filter((c) => c.method === "chat.postMessage");
const failedEvents = () =>
  db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "slack.room_send_failed"))
    .all();

/** Dom opens a topic in the team room and posts `text` in it, as himself. */
const domPosts = async (text: string, threadId?: string) => {
  const dom = { ...DOM_USER, workspaceId };
  const topic =
    threadId ??
    (
      await composed.services.inbox.createThread(dom, {
        teamId: roomTeamId,
        title: "Plan",
      })
    ).id;
  await composed.services.inbox.post(dom, { text, threadId: topic });
  return topic;
};

/** The run a mention started for the agent, as the principal that posts its reply. */
const runPrincipalOf = (slug: string) => {
  const [run] = roomRunsBy(slug);
  if (!run) {
    throw new Error(`no run for ${slug}`);
  }
  return {
    agentId: run.agentId,
    kind: "run",
    runId: run.id,
    workspaceId,
  } as const;
};

const ownerProblems = async () => {
  const view = await composed.services.rail.get(
    { ...ROOM_OWNER, workspaceId },
    { dayStart: new Date(nowMs - 3_600_000).toISOString(), scope: "mine" }
  );
  return view.needsYou.filter((item) =>
    item.cards.some((card) => card.kind === "problem")
  );
};

test("a person's post goes out through the lead's app with their name, and later posts reply in its thread", async () => {
  await setupRoom({ leadListens: false });
  await composed.services.teams.profiles.set(
    { ...DOM_USER, workspaceId },
    { handle: "dom", name: "Dom" }
  );

  const topic = await domPosts("Launch plan draft is ready.");
  await domPosts("Second thought.", topic);

  const [first, second, ...rest] = postCalls();
  expect(rest).toEqual([]);
  expect(first?.auth).toBe(`Bearer ${BOT_TOKEN}`);
  expect(first?.body).toMatchObject({
    channel: ROOM_CHANNEL,
    text: "*Dom:* Launch plan draft is ready.",
  });
  expect(first?.body.thread_ts).toBeUndefined();
  expect(second?.body).toMatchObject({
    channel: ROOM_CHANNEL,
    text: "*Dom:* Second thought.",
    thread_ts: "1789171300.000100",
  });
  expect(roomRows()).toMatchObject([
    { direction: "out", threadTs: null, ts: "1789171300.000100" },
    {
      direction: "out",
      threadTs: "1789171300.000100",
      ts: "1789171300.000101",
    },
  ]);
  expect(failedEvents()).toEqual([]);
});

test("an agent's post goes out through its own app, with no name in front", async () => {
  await setupRoom({ leadListens: false });
  const ada = roomApps[1] as RoomApp;
  const topic = await domPosts(`@${ada.slug} please look at this.`);
  await composed.services.inbox.post(runPrincipalOf(ada.slug), {
    text: "On it.",
    threadId: topic,
  });

  const [fromDom, fromAda, ...rest] = postCalls();
  expect(rest).toEqual([]);
  expect(fromDom?.auth).toBe(`Bearer ${BOT_TOKEN}`);
  expect(fromAda?.auth).toBe(`Bearer ${appToken(ada.apiAppId)}`);
  expect(fromAda?.body).toMatchObject({
    text: "On it.",
    thread_ts: "1789171300.000100",
  });
});

test("an agent whose app is not in the channel posts through the lead's app under its name", async () => {
  await setupRoom({ leadListens: false });
  const ada = roomApps[1] as RoomApp;
  const topic = await domPosts(`@${ada.slug} please look at this.`);
  postAnswer = (call) =>
    call.auth === `Bearer ${appToken(ada.apiAppId)}`
      ? Response.json({ error: "not_in_channel", ok: false })
      : null;
  slackCalls = [];

  await composed.services.inbox.post(runPrincipalOf(ada.slug), {
    text: "On it.",
    threadId: topic,
  });

  const [refused, sent, ...rest] = postCalls();
  expect(rest).toEqual([]);
  expect(refused?.auth).toBe(`Bearer ${appToken(ada.apiAppId)}`);
  expect(sent?.auth).toBe(`Bearer ${BOT_TOKEN}`);
  expect(sent?.body.text).toBe("*Ada:* On it.");
  expect(failedEvents()).toEqual([]);
  expect(roomRows()).toHaveLength(2);
});

test("a send that fails three times raises a problem item for the team owner, and the next send that works clears it", async () => {
  await setupRoom({ leadListens: false });
  postAnswer = () => new Response("", { status: 503 });

  const topic = await domPosts("Anyone there?");

  expect(postCalls()).toHaveLength(3);
  expect(roomRows()).toEqual([]);
  expect(failedEvents()).toMatchObject([
    {
      payload: expect.stringContaining('"error":"http_503"'),
      type: "slack.room_send_failed",
    },
  ]);
  const problems = await ownerProblems();
  expect(problems).toHaveLength(1);
  expect(problems[0]?.cards[0]).toMatchObject({
    kind: "problem",
    runId: null,
    status: "Not reaching Slack",
    threadId: topic,
  });

  postAnswer = () => null;
  // The event log stamps failures with the wall clock, so the retry runs a minute after it.
  nowMs = Date.now() + 60_000;
  await domPosts("Retrying.", topic);

  expect(roomRows()).toMatchObject([{ direction: "out" }]);
  expect(await ownerProblems()).toEqual([]);
});

test("a person who is not the team owner sees no problem item", async () => {
  await setupRoom({ leadListens: false });
  postAnswer = () => Response.json({ error: "not_in_channel", ok: false });

  await domPosts("Anyone there?");

  expect(failedEvents()).toHaveLength(1);
  const view = await composed.services.rail.get(
    { ...DOM_USER, workspaceId },
    { dayStart: new Date(nowMs - 3_600_000).toISOString(), scope: "mine" }
  );
  expect(view.needsYou.filter((i) => i.cards[0]?.kind === "problem")).toEqual(
    []
  );
});

test("a message that came from Slack is not sent back, and neither is the echo of a post that went out", async () => {
  await setupRoom({ leadListens: false });

  await sendToAllApps({ text: "Hello from Slack.", ts: ROOM_FIRST_TS });
  await runAfterJobs();
  expect(postCalls()).toEqual([]);

  const topic = roomTopics()[0]?.id;
  await domPosts("Answering in Agentum.", topic);
  expect(postCalls()).toHaveLength(1);
  const sentTs = roomRows().find((row) => row.direction === "out")?.ts;
  expect(sentTs).toBeDefined();

  // Slack tells every app about the bot's own message, with the bot as the sender.
  await sendToAllApps({
    text: "*Dom:* Answering in Agentum.",
    threadTs: ROOM_FIRST_TS,
    ts: sentTs ?? "",
    user: "U0BOT",
  });
  await runAfterJobs();

  expect(roomPosts()).toHaveLength(2);
  expect(postCalls()).toHaveLength(1);
});

test("a limited topic stays out of Slack", async () => {
  await setupRoom({ leadListens: false });
  const dom = { ...DOM_USER, workspaceId };
  const topic = await composed.services.inbox.createThread(dom, {
    members: [{ id: agentId, kind: "agent" }],
    teamId: roomTeamId,
    title: "Private",
  });

  await composed.services.inbox.post(dom, {
    text: "Just us.",
    threadId: topic.id,
  });

  expect(postCalls()).toEqual([]);
  expect(failedEvents()).toEqual([]);
});

test("a topic of a team with no Slack link stays out of Slack", async () => {
  await setupRoom({ leadListens: false });
  await db.delete(teamSlackLinks);

  await domPosts("Not linked any more.");

  expect(postCalls()).toEqual([]);
});

test("slack.status lists the member apps that are not in the channel", async () => {
  await setupRoom();
  const cy = roomApps[2] as RoomApp;
  outOfChannel.add(appToken(cy.apiAppId));

  const status = await composed.services.teams.slack.status(
    { ...ROOM_OWNER, workspaceId },
    roomTeamId
  );

  expect(status.link).toMatchObject({
    channelId: ROOM_CHANNEL,
    teamId: roomTeamId,
  });
  expect(
    Object.fromEntries(status.apps.map((a) => [a.agentId, a.inChannel]))
  ).toEqual({
    [agentId]: true,
    [(roomApps[1] as RoomApp).agentId]: true,
    [cy.agentId]: false,
    [(roomApps[3] as RoomApp).agentId]: true,
  });
});
