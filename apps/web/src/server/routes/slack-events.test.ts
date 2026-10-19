import { beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { type Atomic, sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { files as fileRows } from "@repo/db/schema/files";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { slackApps, slackEventsSeen } from "@repo/db/schema/slack";
import { identityLinks } from "@repo/db/schema/workspaces";
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
import { type Composed, composeWith } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { slackRoutes } from "./slack.ts";

const ORG = "org_a";
const SECRET = "test-signing-secret";
const SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const BOT_TOKEN = "xoxb-test-token";
const DOM = "user_dom";
const MINUTE_MS = 60_000;
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
const UNLINKED_TEXT =
  "I don't know you yet. Ask a Harbourmaster admin of this workspace to invite you, using the same email address as your Slack profile.";
const HIDDEN_EMAIL_TEXT =
  "I can't see the email address on your Slack profile, so I can't match you to a Harbourmaster account. Ask a Harbourmaster admin of this workspace to invite you, and make your email visible to apps in your Slack profile.";

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
let app: Hono<AppEnv>;
let nowMs: number;
let workspaceId: string;
let agentId: string;
let deferred: (() => Promise<void>)[];
let dropDeferred: boolean;
let failAtomic: boolean;
let slackCalls: SlackCall[];
let slackEmail: string | null;
let downloadStatus: number;
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
  slackCalls.push({
    auth: headers.get("Authorization"),
    body,
    method,
    query: Object.fromEntries(address.searchParams),
  });
  const answers: Record<string, unknown> = {
    "chat.postEphemeral": { ok: true },
    "chat.postMessage": { ok: true, ts: "1789171300.000100" },
    "conversations.info":
      address.searchParams.get("channel") === "C0GONE"
        ? { error: "channel_not_found", ok: false }
        : { channel: { id: "C0CHAN", name: "launch" }, ok: true },
    "files.completeUploadExternal": { ok: true },
    "files.getUploadURLExternal": {
      file_id: OUTPUT_FILE_ID,
      ok: true,
      upload_url: UPLOAD_URL,
    },
    "users.info": {
      ok: true,
      user: {
        id: "U0NEW",
        profile: { email: slackEmail, real_name: "Newcomer" },
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

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse("2026-10-16T10:00:00.000Z");
  deferred = [];
  dropDeferred = false;
  failAtomic = false;
  slackCalls = [];
  slackEmail = "newcomer@example.com";
  downloadStatus = OK;
  directory = { emailOwner: null, member: false };
  composed = composeWith({
    allowedOrgIds: [ORG],
    db,
    infra: {
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
    },
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

test("an output file of a finished run is uploaded to the thread after the answer", async () => {
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
  const file = await composed.services.files.upload(runPrincipal, {
    body: new Blob([SUMMARY_CONTENT]),
    mime: "text/plain",
    name: SUMMARY_NAME,
  });
  await composed.services.runs.completeRun(SYSTEM_PRINCIPAL, runId, {
    fileIds: [file.id],
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
