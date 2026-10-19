import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import {
  slackApps,
  slackEventsSeen,
  slackMessages,
} from "@repo/db/schema/slack";
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
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Composed, composeWith } from "../compose.ts";
import type { AppEnv } from "./groups.ts";
import { slackRoutes } from "./slack.ts";

const ORG = "org_a";
const SECRET = "test-signing-secret";
const SECRETS_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(5)));
const BOT_TOKEN = "xoxb-test-token";
const APP_ROW_ID = "app_row_1";
const DOM = "user_dom";
const SLACK_DOM = "U0DOM";
const UNLINKED_USER = "U0NEW";
const CHANNEL = "C0CHAN";
const DM = "D0DM";
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

type Fixture = Record<string, unknown> & { event: Record<string, unknown> };

interface SlackCall {
  body: Record<string, unknown>;
  method: string;
}

let db: ReturnType<typeof migrated>;
let composed: Composed;
let app: Hono<AppEnv>;
let nowMs: number;
let startMs: number;
let workspaceId: string;
let agentId: string;
let deferred: (() => Promise<void>)[];
let slackCalls: SlackCall[];

const clock: Clock = {
  now: () => new Date(nowMs),
  sleep: (ms) => {
    nowMs += ms;
    return Promise.resolve();
  },
};

/** Answers the Slack methods the listen path can reach, and records every call. */
const fakeSlack = (url: string | URL | Request, init?: RequestInit) => {
  const method = new URL(
    typeof url === "string" ? url : String(url)
  ).pathname.replace("/api/", "");
  const body: Record<string, unknown> =
    typeof init?.body === "string" ? JSON.parse(init.body) : {};
  slackCalls.push({ body, method });
  const answers: Record<string, unknown> = {
    "chat.postMessage": { ok: true, ts: "1789171300.000100" },
    "conversations.info": {
      channel: { id: CHANNEL, name: "launch" },
      ok: true,
    },
    "users.info": {
      ok: true,
      user: { id: UNLINKED_USER, profile: { real_name: "Newcomer" } },
    },
  };
  return Promise.resolve(Response.json(answers[method] ?? { ok: false }));
};

const directory: SlackDirectory = {
  findUserIdByEmail: () => Promise.resolve(null),
  isOrgMember: () => Promise.resolve(false),
};

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse("2026-10-16T10:00:00.000Z");
  startMs = nowMs;
  deferred = [];
  slackCalls = [];
  composed = composeWith({
    allowedOrgIds: [ORG],
    db,
    infra: {
      atomic: sqliteAtomic(db),
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
      slackDirectory: directory,
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
  await installApp();
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
        deferred.push(job);
      },
    })
  );
  app.onError((_error, c) => c.text("error", 500));
});

/** Installs the Slack app row for the test agent, listening to mentions only. */
const installApp = async () => {
  await db.delete(slackApps);
  const key = await importSecretsKey(SECRETS_KEY);
  const row = { id: APP_ROW_ID, workspaceId };
  await db.insert(slackApps).values({
    agentId,
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

const setListenMode = async (mode: "all" | "mentions") => {
  await db
    .update(slackApps)
    .set({ listenMode: mode })
    .where(eq(slackApps.id, APP_ROW_ID));
};

/** A Slack ts for the fake clock, with `n` as the sub-second part so messages differ. */
const tsAt = (n: number): string =>
  `${Math.floor(nowMs / 1000)}.${String(n).padStart(6, "0")}`;

const envelope = (event: Record<string, unknown>): Fixture => ({
  api_app_id: "A0APP",
  event,
  event_id: `Ev${crypto.randomUUID()}`,
  team_id: "T0TEAM",
  type: "event_callback",
});

/** A plain message in a channel, from the linked Dom unless `overrides` says otherwise. */
const plain = (overrides: Record<string, unknown>): Fixture =>
  envelope({
    channel: CHANNEL,
    channel_type: "channel",
    text: "hello",
    ts: tsAt(1),
    type: "message",
    user: SLACK_DOM,
    ...overrides,
  });

const dm = (text: string, ts: string): Fixture =>
  envelope({
    channel: DM,
    channel_type: "im",
    text,
    ts,
    type: "message",
    user: SLACK_DOM,
  });

const appMention = (text: string, ts: string): Fixture =>
  envelope({
    channel: CHANNEL,
    text,
    ts,
    type: "app_mention",
    user: SLACK_DOM,
  });

/** An edit: Slack names the edited message under `message`, and `ts` is its ts. */
const edited = (
  ts: string,
  text: string,
  overrides: Record<string, unknown> = {},
  channel = CHANNEL
): Fixture =>
  envelope({
    channel,
    message: { text, ts, user: SLACK_DOM, ...overrides },
    subtype: "message_changed",
    ts: tsAt(999),
    type: "message",
  });

const deleted = (ts: string, channel = CHANNEL): Fixture =>
  envelope({
    channel,
    deleted_ts: ts,
    subtype: "message_deleted",
    ts: tsAt(999),
    type: "message",
  });

const send = async (body: Fixture) => {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(nowMs / 1000));
  const signature = await signSlackBody({
    body: text,
    signingSecret: SECRET,
    timestamp,
  });
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
const storedMessages = () =>
  db.select().from(slackMessages).orderBy(asc(slackMessages.ts)).all();
const storedTexts = () => storedMessages().map((row) => row.text);
const sessionKeys = () =>
  db
    .select({ externalKey: sessionRows.externalKey })
    .from(sessionRows)
    .all()
    .map((row) => row.externalKey)
    .sort();
const postedMessages = () =>
  slackCalls.filter((call) => call.method === "chat.postMessage");

const runBatches = (minutesAfterStart: number) => {
  nowMs = startMs + minutesAfterStart * MINUTE_MS;
  return composed.services.slack.runDueBatches();
};

test("mentions mode: a plain channel message stores no row and starts no run", async () => {
  await send(plain({ text: "hello all", ts: tsAt(1) }));

  expect(storedMessages()).toEqual([]);
  expect(allRuns()).toEqual([]);
  expect(allSeen()).toEqual([]);
});

test("all mode: a plain channel message is stored unbatched, starts no run and writes no dedupe row", async () => {
  await setListenMode("all");
  await send(plain({ text: "hello all", ts: tsAt(1) }));

  expect(storedMessages()).toMatchObject([
    {
      batchedAt: null,
      channelId: CHANNEL,
      clerkUserId: DOM,
      slackUserId: SLACK_DOM,
      text: "hello all",
      threadTs: null,
    },
  ]);
  expect(allRuns()).toEqual([]);
  expect(allSeen()).toEqual([]);
});

test("all mode: a message from someone not linked is stored with no Harbourmaster user, and Slack is not called", async () => {
  await setListenMode("all");
  await send(plain({ text: "who am I", ts: tsAt(2), user: UNLINKED_USER }));

  expect(storedMessages()).toMatchObject([
    { clerkUserId: null, slackUserId: UNLINKED_USER },
  ]);
  expect(slackCalls).toEqual([]);
});

test("all mode: a retry of the same message is stored once", async () => {
  await setListenMode("all");
  await send(plain({ text: "once", ts: tsAt(3) }));
  await send(plain({ text: "once", ts: tsAt(3) }));

  expect(storedTexts()).toEqual(["once"]);
});

test("all mode: a thread reply in a thread the app does not know is stored with its thread", async () => {
  await setListenMode("all");
  await send(plain({ text: "reply", thread_ts: tsAt(4), ts: tsAt(5) }));

  expect(storedMessages()).toMatchObject([
    { batchedAt: null, text: "reply", threadTs: tsAt(4) },
  ]);
  expect(allRuns()).toEqual([]);
});

test("all mode: a stranger's reply in a thread the app knows is stored for the batch, and starts no run", async () => {
  await setListenMode("all");
  await send(appMention("<@U0BOT> what is up?", tsAt(10)));
  const runsBefore = allRuns().length;

  await send(
    plain({
      text: "stranger reply",
      thread_ts: tsAt(10),
      ts: tsAt(11),
      user: "U0STRANGER",
    })
  );

  expect(allRuns()).toHaveLength(runsBefore);
  expect(storedMessages()).toMatchObject([
    { batchedAt: expect.any(String), text: "<@U0BOT> what is up?" },
    {
      batchedAt: null,
      clerkUserId: null,
      text: "stranger reply",
      threadTs: tsAt(10),
    },
  ]);
});

test("all mode: a message from the app's own bot user or with a bot_id is not stored", async () => {
  await setListenMode("all");
  await send(plain({ text: "echo", ts: tsAt(6), user: "U0BOT" }));
  await send(plain({ bot_id: "B0BOT", text: "from a bot", ts: tsAt(7) }));

  expect(storedMessages()).toEqual([]);
});

test("three messages in a channel within a minute reach the agent as one batch run after five minutes", async () => {
  await setListenMode("all");
  await send(plain({ text: "first note", ts: tsAt(10) }));
  nowMs += 20_000;
  await send(plain({ text: "second note", ts: tsAt(11), user: UNLINKED_USER }));
  nowMs += 20_000;
  await send(plain({ text: "third note", ts: tsAt(12) }));

  await runBatches(4);
  expect(allRuns()).toEqual([]);

  await runBatches(5);
  const [run, ...others] = allRuns();
  expect(others).toEqual([]);
  expect(run?.inputText).toContain("first note");
  expect(run?.inputText).toContain("second note");
  expect(run?.inputText).toContain("third note");
  expect(JSON.parse(run?.reply ?? "null")).toEqual({ kind: "none" });
  expect(sessionKeys()).toEqual(["T0TEAM:C0CHAN:batch"]);
  expect(storedMessages().map((row) => row.batchedAt !== null)).toEqual([
    true,
    true,
    true,
  ]);

  await runBatches(6);
  expect(allRuns()).toHaveLength(1);
});

test("a message stored after a batch waits five minutes from when it was stored", async () => {
  await setListenMode("all");
  await send(plain({ text: "before", ts: tsAt(10) }));
  await runBatches(5);
  expect(allRuns()).toHaveLength(1);

  nowMs = startMs + 6 * MINUTE_MS;
  await send(plain({ text: "late note", ts: tsAt(13) }));

  await runBatches(10);
  expect(allRuns()).toHaveLength(1);

  await runBatches(11);
  expect(allRuns()).toHaveLength(2);
  expect(allRuns()[1]?.inputText).toContain("late note");
});

test("each channel gets its own batch run", async () => {
  await setListenMode("all");
  await send(plain({ text: "launch chatter", ts: tsAt(20) }));
  await send(
    plain({ channel: "C0OTHER", text: "other chatter", ts: tsAt(21) })
  );

  await runBatches(5);

  expect(allRuns()).toHaveLength(2);
  expect(sessionKeys()).toEqual([
    "T0TEAM:C0CHAN:batch",
    "T0TEAM:C0OTHER:batch",
  ]);
});

test("all mode: a mention starts its run at once, is stored as batched, and is not batched again", async () => {
  await setListenMode("all");
  const response = await send(appMention("<@U0BOT> status?", tsAt(30)));
  const { runId } = (await response.json()) as { runId: string };

  expect(storedMessages()).toMatchObject([
    { batchedAt: expect.any(String), text: "<@U0BOT> status?" },
  ]);

  await runBatches(5);
  expect(allRuns().map((run) => run.id)).toEqual([runId]);
});

test("a mention sent as a message event stores nothing and writes no dedupe row, and its app_mention starts the run", async () => {
  await setListenMode("all");
  const ts = tsAt(31);
  await send(plain({ text: "<@U0BOT> status?", ts }));

  expect(storedMessages()).toEqual([]);
  expect(allSeen()).toEqual([]);
  expect(allRuns()).toEqual([]);

  const response = await send(appMention("<@U0BOT> status?", ts));
  expect(await response.json()).toEqual({ ok: true, runId: allRuns()[0]?.id });
  expect(allSeen()).toHaveLength(1);
  expect(storedMessages()).toMatchObject([{ batchedAt: expect.any(String) }]);
});

test("mentions mode: a DM and a mention are stored as batched, since they start runs", async () => {
  await send(dm("hi there", tsAt(40)));
  await send(appMention("<@U0BOT> hey", tsAt(41)));

  expect(storedMessages().map((row) => row.batchedAt !== null)).toEqual([
    true,
    true,
  ]);
  expect(allRuns()).toHaveLength(2);
});

test("a batch run posts nothing on its own, even when it completes", async () => {
  await setListenMode("all");
  await send(plain({ text: "quiet channel", ts: tsAt(50) }));
  await runBatches(5);
  const [run] = allRuns();
  if (!run) {
    throw new Error("the batch run was not started");
  }

  await composed.services.runs.claimRun(SYSTEM_PRINCIPAL, run.id);
  await composed.services.runs.completeRun(SYSTEM_PRINCIPAL, run.id, {
    status: "done",
    text: "Nothing to add.",
  });
  await runAfterJobs();

  expect(postedMessages()).toEqual([]);
});

test("all mode: an edit updates the stored text and a deletion removes the row", async () => {
  await setListenMode("all");
  const ts = tsAt(60);
  await send(plain({ text: "first draft", ts }));

  await send(edited(ts, "final text"));
  expect(storedTexts()).toEqual(["final text"]);

  await send(deleted(ts));
  expect(storedMessages()).toEqual([]);
});

test("mentions mode: an edit and a deletion update a stored DM", async () => {
  const ts = tsAt(61);
  await send(dm("first", ts));

  await send(edited(ts, "edited", {}, DM));
  expect(storedTexts()).toEqual(["edited"]);

  await send(deleted(ts, DM));
  expect(storedMessages()).toEqual([]);
});

test("an edit or a deletion of a message never stored changes nothing", async () => {
  await setListenMode("all");
  await send(plain({ text: "kept", ts: tsAt(62) }));

  await send(edited(tsAt(63), "ghost"));
  await send(deleted(tsAt(64)));

  expect(storedTexts()).toEqual(["kept"]);
});

test("an edit made by a bot is ignored", async () => {
  await setListenMode("all");
  const ts = tsAt(65);
  await send(plain({ text: "human words", ts }));

  await send(edited(ts, "bot words", { bot_id: "B0BOT", user: "U0BOT" }));

  expect(storedTexts()).toEqual(["human words"]);
});

test("purgeSeen deletes stored messages older than 90 days and keeps newer ones", async () => {
  await setListenMode("all");
  await send(plain({ text: "old", ts: tsAt(70) }));

  nowMs = startMs + 91 * DAY_MS;
  await send(plain({ text: "new", ts: tsAt(71) }));
  await composed.services.slack.purgeSeen();

  expect(storedTexts()).toEqual(["new"]);
});
