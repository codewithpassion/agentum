import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { files as fileRows } from "@repo/db/schema/files";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { slackApps } from "@repo/db/schema/slack";
import {
  identityLinks,
  workspaces as workspaceRows,
} from "@repo/db/schema/workspaces";
import { MAX_FILE_BYTES } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { and, eq } from "drizzle-orm";
import { encryptSecret, importSecretsKey } from "../crypto.ts";
import { type Blobs, createEventsService } from "../events.ts";
import { type MemoryFileBlobs, memoryFileBlobs } from "../files/memory.ts";
import { createFilesService } from "../files.ts";
import type {
  Clock,
  DeliveryContext,
  Gateway,
  ReplyTarget,
} from "../runs/types.ts";
import { slackSecretBinding } from "./apps.ts";
import type { SlackFetch } from "./client.ts";
import { createSlackGateway } from "./gateway.ts";

const WORKSPACE = "w1";
const AGENT = "a1";
const SESSION = "s1";
const RUN = "r1";
const START = "2026-10-16T10:00:00.000Z";
const TEAM = "T0TEAM";
const CHANNEL = "C0CHAN";
const THREAD = "1700000000.000100";
const PUBLIC_BASE_URL = "https://app.example.test";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

const SLACK_API = "https://slack.com/api/";
const FILE_URL = "https://files.slack.com/files-pri/T0TEAM-F1/report.pdf";

const slackTarget: ReplyTarget = {
  channel: CHANNEL,
  kind: "slack",
  teamId: TEAM,
  threadTs: THREAD,
};
const context: DeliveryContext = {
  agentId: AGENT,
  onBehalfOfUserId: "u1",
  runId: RUN,
};

/** One request the fake Slack received. */
interface Recorded {
  authorization: string | null;
  body: Record<string, unknown> | null;
  method: string;
  url: string;
}

type Responder = (call: Recorded) => Response;

let db: ReturnType<typeof migrated>;
let fileBlobs: MemoryFileBlobs;
let eventBlobs: Map<string, string>;
let clock: Clock;
let sleeps: number[];
let calls: Recorded[];
let respond: Responder;
let gateway: Gateway;

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

/** Answers like Slack unless a test sets `respond`. */
const defaultResponder: Responder = (call) => {
  if (call.url === `${SLACK_API}chat.postMessage`) {
    return json({ ok: true, ts: "1.5" });
  }
  if (call.url === `${SLACK_API}chat.postEphemeral`) {
    return json({ ok: true });
  }
  return new Response(new Uint8Array(10), {
    headers: { "content-type": "application/pdf" },
  });
};

const slackFetch: SlackFetch = (url, init) => {
  const headers = new Headers(init.headers);
  const body: unknown =
    typeof init.body === "string" ? JSON.parse(init.body) : null;
  const call: Recorded = {
    authorization: headers.get("Authorization"),
    body:
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>)
        : null,
    method: init.method ?? "GET",
    url,
  };
  calls.push(call);
  return Promise.resolve(respond(call));
};

/** The calls made to one Slack method, in order. */
const callsTo = (method: string) =>
  calls.filter((call) => call.url === `${SLACK_API}${method}`);

const insertWorkspace = () =>
  db
    .insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();

beforeEach(async () => {
  db = migrated();
  fileBlobs = memoryFileBlobs();
  eventBlobs = new Map();
  sleeps = [];
  calls = [];
  respond = defaultResponder;
  clock = {
    now: () => new Date(START),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
  insertWorkspace();
  db.insert(agentRows)
    .values({
      createdAt: START,
      createdBy: "u1",
      id: AGENT,
      instructions: "",
      model: "m",
      name: "Agent",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "agent",
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(sessionRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: AGENT,
      createdAt: START,
      id: SESSION,
      origin: "slack",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(runRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: AGENT,
      createdAt: START,
      id: RUN,
      inputText: "hi",
      onBehalfOfUserId: "u1",
      sessionId: SESSION,
      status: "running",
      workspaceId: WORKSPACE,
    })
    .run();

  // The binding needs only the row id and workspace, so the ciphertext can go
  // into the same insert as the row.
  const key = await importSecretsKey(SECRETS_KEY);
  const ref = { id: "sa1", workspaceId: WORKSPACE };
  db.insert(slackApps)
    .values({
      agentId: AGENT,
      appId: "A0APP",
      botToken: await encryptSecret(
        key,
        slackSecretBinding(ref, "bot_token"),
        "xoxb-test"
      ),
      botUserId: "U0BOT",
      createdAt: START,
      id: ref.id,
      signingSecret: await encryptSecret(
        key,
        slackSecretBinding(ref, "signing_secret"),
        "signing-test"
      ),
      status: "installed",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();

  const events = createEventsService({
    blobs: {
      get: (blobKey) => Promise.resolve(eventBlobs.get(blobKey) ?? null),
      put: (blobKey, body) => {
        eventBlobs.set(blobKey, body);
        return Promise.resolve();
      },
    } satisfies Blobs,
    db,
  });
  const files = createFilesService({ blobs: fileBlobs, clock, db });
  gateway = createSlackGateway({
    clock,
    db,
    events,
    fetch: slackFetch,
    files,
    publicBaseUrl: PUBLIC_BASE_URL,
    secretsKey: SECRETS_KEY,
  });
});

/** The `slack.delivered` events of the test run, with parsed payloads. */
const deliveredEvents = () =>
  db
    .select()
    .from(eventRows)
    .where(and(eq(eventRows.runId, RUN), eq(eventRows.type, "slack.delivered")))
    .all()
    .map((row) => JSON.parse(row.payload ?? "{}") as Record<string, unknown>);

const insertIdentityLink = (externalUserId: string) =>
  db
    .insert(identityLinks)
    .values({
      clerkUserId: "u1",
      createdAt: START,
      email: "dominik@example.test",
      externalUserId,
      id: `il_${externalUserId}`,
      provider: "slack",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();

const deliver = (text: string) =>
  gateway.deliver(slackTarget, { fileIds: [], text }, context);

test("deliver posts the reply in the thread with the decrypted bot token", async () => {
  await deliver("The report is ready.");

  const [post] = callsTo("chat.postMessage");
  expect(post?.method).toBe("POST");
  expect(post?.authorization).toBe("Bearer xoxb-test");
  expect(post?.body).toMatchObject({
    channel: CHANNEL,
    text: "The report is ready.",
    thread_ts: THREAD,
  });
  expect(deliveredEvents()).toEqual([
    { channel: CHANNEL, delivered: true, threadTs: THREAD },
  ]);
});

test("deliver retries a rate-limited post after Retry-After and still delivers", async () => {
  let attempt = 0;
  respond = (call) => {
    if (call.url !== `${SLACK_API}chat.postMessage`) {
      return defaultResponder(call);
    }
    attempt += 1;
    return attempt === 1
      ? new Response("", { headers: { "Retry-After": "2" }, status: 429 })
      : json({ ok: true, ts: "1.5" });
  };

  await deliver("Done.");

  expect(callsTo("chat.postMessage")).toHaveLength(2);
  expect(sleeps).toEqual([2000]);
  expect(deliveredEvents()).toEqual([
    { channel: CHANNEL, delivered: true, threadTs: THREAD },
  ]);
});

test("deliver gives up after three transient failures, records it, and does not throw", async () => {
  respond = (call) =>
    call.url === `${SLACK_API}chat.postMessage`
      ? json({ error: "internal_error", ok: false }, { status: 500 })
      : defaultResponder(call);

  await expect(deliver("Done.")).resolves.toBeUndefined();

  expect(callsTo("chat.postMessage")).toHaveLength(3);
  expect(sleeps).toEqual([500, 1000]);
  expect(deliveredEvents()).toEqual([
    {
      channel: CHANNEL,
      delivered: false,
      error: "http_500",
      threadTs: THREAD,
    },
  ]);
});

const CONNECT_TEXT = "Sign in at /connect/conn_1?as=user to continue.";

test("deliver replaces a Connect link in the thread and sends it privately to the mapped user", async () => {
  insertIdentityLink("U0DOM");

  await deliver(CONNECT_TEXT);

  const [post] = callsTo("chat.postMessage");
  expect(post?.body).toMatchObject({
    text: "Sign in at (the link was sent to you privately) to continue.",
  });
  const [ephemeral] = callsTo("chat.postEphemeral");
  expect(ephemeral?.body).toMatchObject({
    channel: CHANNEL,
    thread_ts: THREAD,
    user: "U0DOM",
  });
  expect(String(ephemeral?.body?.text)).toContain(
    `${PUBLIC_BASE_URL}/connect/conn_1?as=user`
  );
});

test("deliver sends no ephemeral Connect message when the user has no identity link", async () => {
  await deliver(CONNECT_TEXT);

  expect(callsTo("chat.postMessage")).toHaveLength(1);
  expect(callsTo("chat.postEphemeral")).toHaveLength(0);
  expect(deliveredEvents()).toEqual([
    { channel: CHANNEL, delivered: true, threadTs: THREAD },
  ]);
});

test("deliver sends only a Connect link under this app's own address, and every copy of it", async () => {
  insertIdentityLink("U0DOM");
  const own = `${PUBLIC_BASE_URL}/connect/conn_1?as=user`;

  await deliver(`First ${own} then again ${own}`);

  const [post] = callsTo("chat.postMessage");
  expect(post?.body?.text).toBe(
    "First (the link was sent to you privately) then again (the link was sent to you privately)"
  );
  expect(callsTo("chat.postEphemeral")).toHaveLength(1);
});

test("deliver leaves a Connect link to another host in the thread and sends nothing privately", async () => {
  insertIdentityLink("U0DOM");
  const evil = "https://evil.example/connect/conn_1";

  await deliver(`Sign in at ${evil} please`);

  const [post] = callsTo("chat.postMessage");
  expect(post?.body?.text).toBe(`Sign in at ${evil} please`);
  expect(callsTo("chat.postEphemeral")).toHaveLength(0);
});

test("deliver keeps the Connect link visible when there is nobody to send it to", async () => {
  await deliver(CONNECT_TEXT);

  const [post] = callsTo("chat.postMessage");
  expect(post?.body?.text).toBe(CONNECT_TEXT);
});

test("deliver records a Connect link that could not be sent privately", async () => {
  insertIdentityLink("U0DOM");
  respond = (call) =>
    call.url === `${SLACK_API}chat.postEphemeral`
      ? json({ error: "user_not_in_channel", ok: false })
      : defaultResponder(call);

  await deliver(CONNECT_TEXT);

  expect(deliveredEvents()).toEqual([
    {
      channel: CHANNEL,
      delivered: true,
      error: "connect link: user_not_in_channel",
      threadTs: THREAD,
    },
  ]);
});

test("deliver escapes control syntax before the text reaches Slack", async () => {
  await deliver("Heads up <!channel> <@U9> the build is done & tested.");

  const [post] = callsTo("chat.postMessage");
  expect(post?.body?.text).toBe(
    "Heads up &lt;!channel&gt; &lt;@U9&gt; the build is done &amp; tested."
  );
});

test("deliver posts (no reply) for an empty answer", async () => {
  await deliver("");

  const [post] = callsTo("chat.postMessage");
  expect(post?.body).toMatchObject({ text: "(no reply)" });
});

test("deliver does nothing for a reply target that is not Slack", async () => {
  await gateway.deliver(
    { kind: "inbox", threadId: "t1" },
    { fileIds: [], text: "Hello" },
    context
  );

  expect(calls).toHaveLength(0);
  expect(deliveredEvents()).toEqual([]);
});

/** A Slack file descriptor as the message handler stores it. */
const descriptor = (overrides: Partial<Record<string, unknown>>) => ({
  id: "F1",
  mimetype: "application/pdf",
  name: "report.pdf",
  size: 10,
  teamId: TEAM,
  url: FILE_URL,
  ...overrides,
});

const downloadFiles = (descriptors: unknown[]) => {
  const download = gateway.downloadPendingFiles;
  if (!download) {
    throw new Error("the Slack gateway has no downloadPendingFiles");
  }
  return download(descriptors, { ...context, workspaceId: WORKSPACE });
};

test("downloadPendingFiles stores allowed files for the run's user and skips a disallowed type", async () => {
  const exe = descriptor({
    id: "F2",
    mimetype: "application/x-msdownload",
    name: "setup.exe",
    url: "https://files.slack.com/files-pri/T0TEAM-F2/setup.exe",
  });

  const ids = await downloadFiles([descriptor({}), exe]);

  expect(ids).toHaveLength(1);
  const [id] = ids;
  const [row] = db
    .select()
    .from(fileRows)
    .where(eq(fileRows.id, id ?? ""))
    .all();
  expect(row).toMatchObject({
    createdById: "u1",
    createdByKind: "user",
    mime: "application/pdf",
    name: "report.pdf",
    size: 10,
    source: "slack",
    workspaceId: WORKSPACE,
  });
  const stored = fileBlobs.objects.get(`${WORKSPACE}/files/${id}`);
  expect(stored?.bytes.byteLength).toBe(10);
  expect(calls.map((call) => call.url)).toEqual([FILE_URL]);
});

test("downloadPendingFiles skips a file larger than the cap without fetching it", async () => {
  const huge = descriptor({
    size: MAX_FILE_BYTES + 1,
    url: "https://files.slack.com/files-pri/T0TEAM-F3/big.pdf",
  });

  const ids = await downloadFiles([huge]);

  expect(ids).toEqual([]);
  expect(calls).toHaveLength(0);
});

test("downloadPendingFiles throws when the file URL answers 500", async () => {
  respond = () => new Response("oops", { status: 500 });

  await expect(downloadFiles([descriptor({})])).rejects.toThrow(
    "Slack file download failed: http_500"
  );
});

test("downloadPendingFiles skips a URL that is not on a Slack host", async () => {
  const elsewhere = descriptor({ url: "https://example.com/report.pdf" });

  const ids = await downloadFiles([elsewhere]);

  expect(ids).toEqual([]);
  expect(calls).toHaveLength(0);
});
