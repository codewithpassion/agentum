import { beforeEach, expect, test } from "bun:test";
import { agents as agentRows } from "@repo/db/schema/agents";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { slackApps, slackMessages } from "@repo/db/schema/slack";
import {
  identityLinks,
  workspaces as workspaceRows,
} from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { encryptSecret, importSecretsKey } from "./crypto.ts";
import { slackSecretBinding } from "./slack/apps.ts";
import type { SlackFetch } from "./slack/client.ts";
import {
  createSlackHistoryService,
  type SlackHistoryService,
} from "./slack-history.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const AGENT = "a1";
const SESSION = "s1";
const RUN = "r1";
const START = "2026-10-16T10:00:00.000Z";
const TEAM = "T0TEAM";
const APP_ROW = "sa1";
const ANN_EMAIL = "ann@example.test";
const ANN_USER = "U0ANN";
const GHOST_USER = "U0GHOST";
const SECRETS_KEY = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
const NEEDS_REINSTALL = /im:write[\s\S]*reinstall/;
const NO_APP_TEXT = "no Slack app installed";
const CHANNEL_NOT_IN = /not in "/;

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
  url: URL;
}

type MessageRow = typeof slackMessages.$inferInsert;

let db: ReturnType<typeof migrated>;
let service: SlackHistoryService;
let calls: Recorded[];
let overrides: Map<string, (url: URL) => Response>;
let rowCount: number;

const json = (body: unknown) => Response.json(body);

const emptyHistory = () =>
  json({ messages: [], ok: true, response_metadata: { next_cursor: "" } });

/** Answers like Slack unless a test puts an override on the method. */
const answer = (method: string, url: URL): Response => {
  switch (method) {
    case "users.conversations":
      return json({ channels: CHANNELS, ok: true });
    case "users.info":
      return url.searchParams.get("user") === GHOST_USER
        ? json({ error: "user_not_found", ok: false })
        : json({ ok: true, user: { profile: { real_name: "Ann Lee" } } });
    case "conversations.history":
    case "conversations.replies":
      return emptyHistory();
    default:
      return json({ error: `unexpected ${method}`, ok: false });
  }
};

const slackFetch: SlackFetch = (url, init) => {
  const parsed = new URL(url);
  const method = parsed.pathname.slice("/api/".length);
  const body =
    typeof init.body === "string"
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : null;
  calls.push({ body, method, url: parsed });
  const override = overrides.get(method);
  return Promise.resolve(override ? override(parsed) : answer(method, parsed));
};

const callsTo = (method: string) =>
  calls.filter((call) => call.method === method);

/** Resolves to the error a promise rejects with. Fails the test if it resolves. */
const refusalOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (error: unknown) => error
  );

/** Stores a message row for the app `APP_ROW` unless the test overrides a column. */
const seed = (row: Partial<MessageRow> & Pick<MessageRow, "text">) => {
  rowCount += 1;
  db.insert(slackMessages)
    .values({
      appId: APP_ROW,
      batchedAt: null,
      channelId: "C0GENERAL",
      clerkUserId: null,
      createdAt: START,
      id: `m${rowCount}`,
      slackUserId: ANN_USER,
      threadTs: null,
      ts: `${1_700_000_000 + rowCount}.000100`,
      workspaceId: WORKSPACE,
      ...row,
    })
    .run();
};

const hitTexts = (hits: { text: string }[]) => hits.map((hit) => hit.text);

beforeEach(async () => {
  db = migrated();
  calls = [];
  overrides = new Map();
  rowCount = 0;
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
  const ref = { id: APP_ROW, workspaceId: WORKSPACE };
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

  service = createSlackHistoryService({
    db,
    fetch: slackFetch,
    secretsKey: SECRETS_KEY,
  });
});

/** A second agent with its own Slack app in the same workspace and team. */
const addOtherApp = () => {
  db.insert(agentRows)
    .values({
      createdAt: START,
      createdBy: "u1",
      id: "a2",
      instructions: "",
      model: "m",
      name: "Other",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "other",
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(slackApps)
    .values({
      agentId: "a2",
      appId: "A0OTHER",
      botUserId: "U0OTHER",
      createdAt: START,
      id: "sa2",
      signingSecret: "not-read",
      status: "installed",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();
};

test("history refuses a channel the bot is not in and makes no history call", async () => {
  expect(
    await refusalOf(service.history(runPrincipal, { channel: "#finance" }))
  ).toMatchObject({
    code: "not_found",
    message: expect.stringMatching(CHANNEL_NOT_IN),
  });
  expect(
    await refusalOf(service.history(runPrincipal, { channel: "C0FINANCE1" }))
  ).toMatchObject({ code: "not_found" });
  expect(callsTo("conversations.history")).toHaveLength(0);
  expect(callsTo("conversations.replies")).toHaveLength(0);
});

test("history reads a channel by name and by id, oldest first, with names and an id fallback", async () => {
  overrides.set("conversations.history", () =>
    json({
      messages: [
        { text: "third", ts: "1700000120.000100", user: ANN_USER },
        { text: "second", ts: "1700000060.000100", user: GHOST_USER },
        { bot_id: "B0BOT", text: "first", ts: "1700000000.000100" },
      ],
      ok: true,
      response_metadata: { next_cursor: "" },
    })
  );

  const byName = await service.history(runPrincipal, { channel: "#general" });
  const byId = await service.history(runPrincipal, { channel: "C0GENERAL" });

  expect(byName).toEqual({
    channel: "C0GENERAL",
    messages: [
      {
        author: "bot B0BOT",
        text: "first",
        threadTs: null,
        time: "2023-11-14T22:13:20.000Z",
        ts: "1700000000.000100",
      },
      {
        author: GHOST_USER,
        text: "second",
        threadTs: null,
        time: "2023-11-14T22:14:20.000Z",
        ts: "1700000060.000100",
      },
      {
        author: "Ann Lee",
        text: "third",
        threadTs: null,
        time: "2023-11-14T22:15:20.000Z",
        ts: "1700000120.000100",
      },
    ],
    nextCursor: null,
  });
  expect(byId.channel).toBe("C0GENERAL");
  expect(
    callsTo("conversations.history")[0]?.url.searchParams.get("channel")
  ).toBe("C0GENERAL");
});

test("history with threadTs reads the replies to that parent, already oldest first", async () => {
  overrides.set("conversations.replies", () =>
    json({
      messages: [
        {
          text: "parent",
          thread_ts: "1700000000.000100",
          ts: "1700000000.000100",
          user: ANN_USER,
        },
        {
          text: "reply",
          thread_ts: "1700000000.000100",
          ts: "1700000060.000200",
          user: ANN_USER,
        },
      ],
      ok: true,
      response_metadata: { next_cursor: "" },
    })
  );

  const result = await service.history(runPrincipal, {
    channel: "general",
    threadTs: "1700000000.000100",
  });

  expect(callsTo("conversations.history")).toHaveLength(0);
  expect(callsTo("conversations.replies")[0]?.url.searchParams.get("ts")).toBe(
    "1700000000.000100"
  );
  expect(result.messages.map((message) => message.text)).toEqual([
    "parent",
    "reply",
  ]);
  expect(result.messages[1]?.threadTs).toBe("1700000000.000100");
});

test("since and until become oldest and latest with six decimals", async () => {
  await service.history(runPrincipal, {
    channel: "C0GENERAL",
    since: "2023-11-14T22:00:00Z",
    until: "2023-11-14T23:00:00Z",
  });

  const params = callsTo("conversations.history")[0]?.url.searchParams;
  expect(params?.get("oldest")).toBe("1699999200.000000");
  expect(params?.get("latest")).toBe("1700002800.000000");
});

test("the cursor goes to Slack and Slack's next cursor comes back", async () => {
  overrides.set("conversations.history", () =>
    json({
      messages: [],
      ok: true,
      response_metadata: { next_cursor: "next-page" },
    })
  );

  const result = await service.history(runPrincipal, {
    channel: "C0GENERAL",
    cursor: "this-page",
  });

  expect(
    callsTo("conversations.history")[0]?.url.searchParams.get("cursor")
  ).toBe("this-page");
  expect(result.nextCursor).toBe("next-page");
});

test("history defaults to 50 messages and refuses a limit of 0 or 201", async () => {
  await service.history(runPrincipal, { channel: "C0GENERAL" });
  expect(
    callsTo("conversations.history")[0]?.url.searchParams.get("limit")
  ).toBe("50");

  const refusals = await Promise.all(
    [0, 201].map((limit) =>
      refusalOf(service.history(runPrincipal, { channel: "C0GENERAL", limit }))
    )
  );
  for (const refusal of refusals) {
    expect(refusal).toMatchObject({ code: "invalid" });
  }
  expect(callsTo("conversations.history")).toHaveLength(1);
});

test("history refuses an invalid date and a since after until", async () => {
  expect(
    await refusalOf(
      service.history(runPrincipal, { channel: "C0GENERAL", since: "soon" })
    )
  ).toMatchObject({ code: "invalid" });
  expect(
    await refusalOf(
      service.history(runPrincipal, {
        channel: "C0GENERAL",
        since: "2026-10-17T00:00:00Z",
        until: "2026-10-16T00:00:00Z",
      })
    )
  ).toMatchObject({ code: "invalid" });
  expect(callsTo("conversations.history")).toHaveLength(0);
});

test("history refuses a principal that is not a run", async () => {
  const user: Principal = {
    kind: "user",
    userId: "u1",
    via: "session",
    workspaceId: WORKSPACE,
  };

  expect(
    await refusalOf(service.history(user, { channel: "C0GENERAL" }))
  ).toMatchObject({ code: "invalid" });
  expect(calls).toHaveLength(0);
});

test("history refuses an agent with no Slack app", async () => {
  db.update(slackApps).set({ status: "revoked" }).run();

  expect(
    await refusalOf(service.history(runPrincipal, { channel: "C0GENERAL" }))
  ).toMatchObject({
    code: "not_found",
    message: expect.stringContaining(NO_APP_TEXT),
  });
});

test("a missing_scope answer from Slack becomes the reinstall refusal", async () => {
  overrides.set("conversations.history", () =>
    json({ error: "missing_scope", ok: false })
  );

  expect(
    await refusalOf(service.history(runPrincipal, { channel: "C0GENERAL" }))
  ).toMatchObject({
    code: "conflict",
    message: expect.stringMatching(NEEDS_REINSTALL),
  });
});

test("search needs every query word to match", async () => {
  seed({ text: "deploy the staging worker" });
  seed({ text: "deploy notes only" });

  const result = await service.search(runPrincipal, { query: "deploy worker" });

  expect(hitTexts(result.hits)).toEqual(["deploy the staging worker"]);
});

test("search filters by channel name and by channel id", async () => {
  seed({ channelId: "C0GENERAL", text: "launch plan" });
  seed({ channelId: "C0LEADS", text: "launch budget" });

  const byName = await service.search(runPrincipal, {
    channel: "#general",
    query: "launch",
  });
  const byId = await service.search(runPrincipal, {
    channel: "C0LEADS",
    query: "launch",
  });

  expect(hitTexts(byName.hits)).toEqual(["launch plan"]);
  expect(byName.hits[0]?.channel).toBe("C0GENERAL");
  expect(hitTexts(byId.hits)).toEqual(["launch budget"]);
  expect(byId.hits[0]?.channel).toBe("C0LEADS");
});

test("search refuses a channel name the bot is not in", async () => {
  expect(
    await refusalOf(
      service.search(runPrincipal, { channel: "#finance", query: "launch" })
    )
  ).toMatchObject({
    code: "not_found",
    message: expect.stringMatching(CHANNEL_NOT_IN),
  });
});

test("search filters by person, by Slack id and by linked email", async () => {
  seed({ slackUserId: ANN_USER, text: "ship it" });
  seed({ slackUserId: "U0BO", text: "ship it too" });

  const byId = await service.search(runPrincipal, {
    person: "U0BO",
    query: "ship",
  });
  const byEmail = await service.search(runPrincipal, {
    person: ANN_EMAIL.toUpperCase(),
    query: "ship",
  });

  expect(hitTexts(byId.hits)).toEqual(["ship it too"]);
  expect(hitTexts(byEmail.hits)).toEqual(["ship it"]);
  expect(byEmail.hits[0]?.author).toBe(ANN_EMAIL);
});

test("search filters by since and until", async () => {
  seed({ createdAt: "2026-10-10T00:00:00.000Z", text: "status old" });
  seed({ createdAt: "2026-10-15T00:00:00.000Z", text: "status mid" });
  seed({ createdAt: "2026-10-18T00:00:00.000Z", text: "status new" });

  const result = await service.search(runPrincipal, {
    query: "status",
    since: "2026-10-12T00:00:00Z",
    until: "2026-10-16T00:00:00Z",
  });

  expect(hitTexts(result.hits)).toEqual(["status mid"]);
});

test("search never returns another app's rows or DM rows", async () => {
  addOtherApp();
  seed({ channelId: "C0GENERAL", text: "audit ours" });
  seed({ appId: "sa2", channelId: "C0GENERAL", text: "audit theirs" });
  seed({ channelId: "D0ANN", text: "audit dm" });

  const result = await service.search(runPrincipal, { query: "audit" });

  expect(hitTexts(result.hits)).toEqual(["audit ours"]);
});

test("search honours the limit, and defaults to 20", async () => {
  for (let index = 0; index < 21; index += 1) {
    seed({ text: `batch note ${index}` });
  }

  const defaulted = await service.search(runPrincipal, { query: "batch" });
  const limited = await service.search(runPrincipal, {
    limit: 3,
    query: "batch",
  });

  expect(defaulted.hits).toHaveLength(20);
  expect(limited.hits).toHaveLength(3);
});

test("search refuses an empty query, a query over 200 characters, and a limit over 50", async () => {
  expect(
    await refusalOf(service.search(runPrincipal, { query: "   " }))
  ).toMatchObject({ code: "invalid" });
  expect(
    await refusalOf(service.search(runPrincipal, { query: "x".repeat(201) }))
  ).toMatchObject({ code: "invalid" });
  expect(
    await refusalOf(service.search(runPrincipal, { limit: 51, query: "x" }))
  ).toMatchObject({ code: "invalid" });
});

test("search refuses a principal that is not a run", async () => {
  const user: Principal = {
    kind: "user",
    userId: "u1",
    via: "session",
    workspaceId: WORKSPACE,
  };

  expect(await refusalOf(service.search(user, { query: "x" }))).toMatchObject({
    code: "invalid",
  });
});

test("search gives the Slack id as author when the person is not linked, and the time from the ts", async () => {
  seed({ slackUserId: "U0BO", text: "unlinked note", ts: "1700000000.000100" });

  const result = await service.search(runPrincipal, { query: "unlinked" });

  expect(result.hits).toEqual([
    {
      author: "U0BO",
      channel: "C0GENERAL",
      text: "unlinked note",
      threadTs: null,
      time: "2023-11-14T22:13:20.000Z",
      ts: "1700000000.000100",
    },
  ]);
});

test("search reads the stored rows, so it makes no call to Slack for an id", async () => {
  seed({ text: "no slack needed" });

  await service.search(runPrincipal, { channel: "C0GENERAL", query: "slack" });

  expect(calls).toHaveLength(0);
});
