import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events as eventRows } from "@repo/db/schema/events";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { slackApps, slackThreads } from "@repo/db/schema/slack";
import {
  identityLinks,
  workspaces as workspaceRows,
} from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { encryptSecret, importSecretsKey } from "./crypto.ts";
import {
  type Blobs,
  createEventsService,
  type EventsService,
} from "./events.ts";
import type { Clock } from "./runs/types.ts";
import { slackSecretBinding } from "./slack/apps.ts";
import type { SlackFetch } from "./slack/client.ts";
import { createSlackSendService, type SlackSendService } from "./slack-send.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const AGENT = "a1";
const SESSION = "s1";
const RUN = "r1";
const START = "2026-10-16T10:00:00.000Z";
const TEAM = "T0TEAM";
const ANN_EMAIL = "ann@example.test";
const ANN_USER = "U0ANN";
const ANN_DM = "D0ANN";
const HOUR_MS = 60 * 60 * 1000;
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const NEEDS_REINSTALL = /im:write[\s\S]*reinstall/;

const runPrincipal: Principal = {
  agentId: AGENT,
  kind: "run",
  runId: RUN,
  workspaceId: WORKSPACE,
};

const CHANNELS = [
  { id: "C0GENERAL", is_private: false, name: "general" },
  { id: "C0LEADS", is_private: true, name: "leads" },
];

/** One call the fake Slack received. `method` is the API method, without the query. */
interface Recorded {
  body: Record<string, unknown> | null;
  method: string;
}

let db: ReturnType<typeof migrated>;
let clock: Clock;
let now: Date;
let events: EventsService;
let service: SlackSendService;
let calls: Recorded[];
let overrides: Map<string, () => Response>;
let postCount: number;

const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

/** Answers like Slack unless a test puts an override on the method. */
const answer = (
  method: string,
  url: URL,
  body: Record<string, unknown> | null
): Response => {
  switch (method) {
    case "users.conversations":
      return json({ channels: CHANNELS, ok: true });
    case "users.info":
      return json({
        ok: true,
        user: { profile: { real_name: "Ann Lee" } },
      });
    case "conversations.open":
      return json({ channel: { id: ANN_DM }, ok: true });
    case "chat.postMessage":
      postCount += 1;
      return json({ ok: true, ts: `${1_700_000_000 + postCount}.000100` });
    case "chat.getPermalink":
      return json({
        ok: true,
        permalink: `https://acme.slack.com/archives/${url.searchParams.get("channel")}/p${url.searchParams.get("message_ts")}`,
      });
    default:
      return json({
        error: `unexpected ${method} ${JSON.stringify(body)}`,
        ok: false,
      });
  }
};

const slackFetch: SlackFetch = (url, init) => {
  const parsed = new URL(url);
  const method = parsed.pathname.slice("/api/".length);
  const body =
    typeof init.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : null;
  calls.push({ body, method });
  const override = overrides.get(method);
  return Promise.resolve(override ? override() : answer(method, parsed, body));
};

const callsTo = (method: string) =>
  calls.filter((call) => call.method === method);

const sendEvents = () =>
  db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "slack.message_sent"))
    .all();

const threadRows = () => db.select().from(slackThreads).all();

/** Resolves to the error a promise rejects with. Fails the test if it resolves. */
const refusalOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => error
  );

beforeEach(async () => {
  db = migrated();
  calls = [];
  overrides = new Map();
  postCount = 0;
  // The events service stamps rows with the real time, so the clock starts there.
  now = new Date();
  clock = {
    now: () => now,
    sleep: () => Promise.resolve(),
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
  db.insert(identityLinks)
    .values({
      clerkUserId: "user_ann",
      createdAt: START,
      email: ANN_EMAIL,
      externalUserId: ANN_USER,
      id: "il1",
      provider: "slack",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();

  const blobs: Blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  events = createEventsService({ blobs, db });
  service = createSlackSendService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    fetch: slackFetch,
    secretsKey: SECRETS_KEY,
  });
});

test("lists channels and linked people", async () => {
  const result = await service.destinations(runPrincipal);

  expect(result).toEqual({
    channels: [
      { id: "C0GENERAL", isPrivate: false, name: "general" },
      { id: "C0LEADS", isPrivate: true, name: "leads" },
    ],
    people: [{ email: ANN_EMAIL, slackName: "Ann Lee" }],
  });
});

test("sends to a channel by name and by id", async () => {
  const byName = await service.send(runPrincipal, {
    text: "  Hello team  ",
    to: "#general",
  });
  const byId = await service.send(runPrincipal, {
    text: "Second",
    to: "C0GENERAL",
  });

  expect(byName).toMatchObject({
    channel: "C0GENERAL",
    permalink: `https://acme.slack.com/archives/C0GENERAL/p${byName.ts}`,
    to: "#general",
  });
  expect(byId).toMatchObject({ channel: "C0GENERAL", to: "#general" });
  expect(callsTo("chat.postMessage")[0]?.body?.text).toBe("Hello team");

  const rows = sendEvents();
  expect(rows).toHaveLength(2);
  expect(JSON.parse(rows[0]?.payload ?? "{}")).toMatchObject({
    channel: "C0GENERAL",
    channelName: "general",
    ts: byName.ts,
  });

  const threads = threadRows();
  expect(threads.map((thread) => thread.threadTs).sort()).toEqual(
    [byName.ts, byId.ts].sort()
  );
  for (const thread of threads) {
    expect(thread.sessionId).toBe(SESSION);
    expect(thread.channelId).toBe("C0GENERAL");
  }
});

test("sends to a person in a DM opened with their Slack id", async () => {
  const result = await service.send(runPrincipal, {
    text: "Hi Ann",
    to: ANN_EMAIL,
  });

  expect(callsTo("conversations.open")[0]?.body).toEqual({ users: ANN_USER });
  expect(callsTo("chat.postMessage")[0]?.body?.channel).toBe(ANN_DM);
  expect(result).toMatchObject({ channel: ANN_DM, to: ANN_EMAIL });

  const [row] = sendEvents();
  expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({
    channel: ANN_DM,
    person: ANN_EMAIL,
  });
});

test("sends into its own thread with threadTs and adds no thread row", async () => {
  const first = await service.send(runPrincipal, {
    text: "Start",
    to: "#general",
  });
  const reply = await service.send(runPrincipal, {
    text: "Reply",
    threadTs: first.ts,
    to: "#general",
  });

  expect(callsTo("chat.postMessage")[1]?.body?.thread_ts).toBe(first.ts);
  expect(reply.ts).not.toBe(first.ts);
  expect(threadRows()).toHaveLength(1);
  expect(sendEvents()).toHaveLength(2);
  expect(JSON.parse(sendEvents()[1]?.payload ?? "{}")).toMatchObject({
    threadTs: first.ts,
  });
});

test("refuses a channel the bot is not in", async () => {
  expect(
    await refusalOf(service.send(runPrincipal, { text: "Hi", to: "#finance" }))
  ).toMatchObject({
    code: "not_found",
    message: expect.stringContaining("not in"),
  });
  expect(
    await refusalOf(
      service.send(runPrincipal, { text: "Hi", to: "C0FINANCE1" })
    )
  ).toMatchObject({ code: "not_found" });
  expect(callsTo("chat.postMessage")).toHaveLength(0);
});

test("refuses an unlinked or unknown person", async () => {
  expect(
    await refusalOf(
      service.send(runPrincipal, { text: "Hi", to: "bo@example.test" })
    )
  ).toMatchObject({ code: "not_found" });
  expect(
    await refusalOf(
      service.send(runPrincipal, { text: "Hi", to: "Nobody Here" })
    )
  ).toMatchObject({ code: "not_found" });
  expect(callsTo("conversations.open")).toHaveLength(0);
});

test("refuses an agent without an installed Slack app", async () => {
  db.update(slackApps).set({ status: "revoked" }).run();

  expect(
    await refusalOf(service.send(runPrincipal, { text: "Hi", to: "#general" }))
  ).toMatchObject({
    code: "not_found",
    message: expect.stringContaining("no Slack app installed"),
  });
  expect(await refusalOf(service.destinations(runPrincipal))).toMatchObject({
    code: "not_found",
  });
});

test("refuses a principal that is not a run", async () => {
  const user: Principal = {
    kind: "user",
    userId: "u1",
    via: "session",
    workspaceId: WORKSPACE,
  };

  expect(await refusalOf(service.destinations(user))).toMatchObject({
    code: "invalid",
  });
  expect(
    await refusalOf(
      service.send({ kind: "system" }, { text: "Hi", to: "#general" })
    )
  ).toMatchObject({ code: "invalid" });
  expect(calls).toHaveLength(0);
});

test("refuses a threadTs the agent did not start", async () => {
  expect(
    await refusalOf(
      service.send(runPrincipal, {
        text: "Reply",
        threadTs: "1700000000.999999",
        to: "#general",
      })
    )
  ).toMatchObject({ code: "invalid" });
  expect(callsTo("chat.postMessage")).toHaveLength(0);
});

test("allows 30 sends an hour, refuses the 31st, and allows one again after the hour", async () => {
  for (let index = 0; index < 30; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each send is counted before the next one
    await service.send(runPrincipal, {
      text: `Message ${index}`,
      to: "#general",
    });
  }
  expect(sendEvents()).toHaveLength(30);

  const [oldest] = sendEvents()
    .map((row) => row.createdAt)
    .sort();
  if (oldest === undefined) {
    throw new Error("no send events");
  }
  const nextAllowed = new Date(Date.parse(oldest) + HOUR_MS).toISOString();

  expect(
    await refusalOf(
      service.send(runPrincipal, { text: "One too many", to: "#general" })
    )
  ).toMatchObject({
    code: "conflict",
    message: expect.stringContaining(`next send is allowed at ${nextAllowed}`),
  });
  expect(sendEvents()).toHaveLength(30);

  now = new Date(nextAllowed);
  await service.send(runPrincipal, { text: "Back again", to: "#general" });
  expect(sendEvents()).toHaveLength(31);
});

test("missing_scope from conversations.open and from chat.postMessage gives the reinstall message", async () => {
  overrides.set("conversations.open", () =>
    json({ error: "missing_scope", ok: false })
  );
  expect(
    await refusalOf(service.send(runPrincipal, { text: "Hi", to: ANN_EMAIL }))
  ).toMatchObject({
    code: "conflict",
    message: expect.stringMatching(NEEDS_REINSTALL),
  });

  overrides.set("chat.postMessage", () =>
    json({ error: "missing_scope", ok: false })
  );
  expect(
    await refusalOf(service.send(runPrincipal, { text: "Hi", to: "#general" }))
  ).toMatchObject({
    code: "conflict",
    message: expect.stringMatching(NEEDS_REINSTALL),
  });
});

test("the send event never holds the message text", async () => {
  const text = "  Launch plan 4242 is ready  ";
  const result = await service.send(runPrincipal, { text, to: "#general" });

  const [row] = sendEvents();
  const raw = row?.payload ?? "";
  expect(raw).not.toContain("Launch");
  expect(raw).not.toContain("4242");
  expect(JSON.parse(raw)).toMatchObject({
    channel: "C0GENERAL",
    channelName: "general",
    textLength: "Launch plan 4242 is ready".length,
    ts: result.ts,
  });
});

test("a Slack failure on postMessage writes no event and no thread row", async () => {
  overrides.set("chat.postMessage", () =>
    json({ error: "msg_too_long", ok: false })
  );

  expect(
    await refusalOf(service.send(runPrincipal, { text: "Hi", to: "#general" }))
  ).toMatchObject({
    code: "conflict",
    message: expect.stringContaining("msg_too_long"),
  });
  expect(sendEvents()).toHaveLength(0);
  expect(threadRows()).toHaveLength(0);
});
