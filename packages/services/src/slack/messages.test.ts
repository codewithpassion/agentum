import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { slackApps, slackMessages } from "@repo/db/schema/slack";
import {
  identityLinks,
  workspaces as workspaceRows,
} from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import {
  BATCH_MESSAGES_MAX,
  deleteMessage,
  findDueBatches,
  MESSAGE_RETENTION_MS,
  markBatchedStatements,
  purgeMessagesBefore,
  SEARCH_LIMIT_MAX,
  type StoredMessageInput,
  searchMessages,
  storeMessageStatement,
  unbatchedMessages,
  updateMessageText,
} from "./messages.ts";

const WORKSPACE = "w1";
const TEAM = "T0TEAM";
const CHANNEL = "C0GEN";
const GROUP = "G0GROUP";
const DM = "D0DM";
const MAIN_APP = "row_main";
const OTHER_APP = "row_other";
const MENTIONS_APP = "row_mentions";
const REVOKED_APP = "row_revoked";
const IDLE_APP = "row_idle";

/** A fixed clock: minutes after 2026-10-16T10:00Z. */
const at = (minutes: number): string =>
  new Date(Date.UTC(2026, 9, 16, 10, 0, 0) + minutes * 60_000).toISOString();

let db: ReturnType<typeof migrated>;

const insertApp = (
  id: string,
  overrides: {
    agentId: string;
    appId: string;
    listenMode?: "mentions" | "all";
    status?: "created" | "installed" | "revoked";
    teamId?: string;
  }
) =>
  db
    .insert(slackApps)
    .values({
      agentId: overrides.agentId,
      appId: overrides.appId,
      botUserId: "U0BOT",
      createdAt: at(0),
      id,
      listenMode: overrides.listenMode ?? "all",
      signingSecret: "ciphertext",
      status: overrides.status ?? "installed",
      teamId: overrides.teamId ?? TEAM,
      workspaceId: WORKSPACE,
    })
    .run();

const insertAgent = (id: string, status: string) =>
  db
    .insert(agentRows)
    .values({
      createdAt: at(0),
      createdBy: "u1",
      id,
      instructions: "",
      model: "m",
      name: id,
      runtime: "fake",
      runtimeConfig: "{}",
      slug: id,
      status,
      workspaceId: WORKSPACE,
    })
    .run();

const base: StoredMessageInput = {
  appId: MAIN_APP,
  batchedAt: null,
  channelId: CHANNEL,
  clerkUserId: null,
  createdAt: at(0),
  slackUserId: "U1",
  text: "hello",
  threadTs: null,
  ts: "1700000000.000100",
  workspaceId: WORKSPACE,
};

const addMessages = async (inputs: Partial<StoredMessageInput>[]) => {
  await sqliteAtomic(db)(
    inputs.map((input) => storeMessageStatement(db, { ...base, ...input }))
  );
};

const allRows = () => db.select().from(slackMessages).all();

const idByTs = (ts: string): string => {
  const row = db
    .select({ id: slackMessages.id })
    .from(slackMessages)
    .where(eq(slackMessages.ts, ts))
    .get();
  if (!row) {
    throw new Error(`no row with ts ${ts}`);
  }
  return row.id;
};

beforeEach(() => {
  db = migrated();
  db.insert(workspaceRows)
    .values({
      clerkOrgId: `org_${WORKSPACE}`,
      createdAt: at(0),
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  insertAgent("a_main", "active");
  insertAgent("a_other", "active");
  insertAgent("a_mentions", "active");
  insertAgent("a_revoked", "active");
  insertAgent("a_idle", "paused");
  insertApp(MAIN_APP, { agentId: "a_main", appId: "A0MAIN" });
  insertApp(OTHER_APP, { agentId: "a_other", appId: "A0OTHER" });
  insertApp(MENTIONS_APP, {
    agentId: "a_mentions",
    appId: "A0MENTIONS",
    listenMode: "mentions",
  });
  insertApp(REVOKED_APP, {
    agentId: "a_revoked",
    appId: "A0REVOKED",
    status: "revoked",
  });
  insertApp(IDLE_APP, { agentId: "a_idle", appId: "A0IDLE" });
});

test("storeMessageStatement is idempotent on the same app, channel and ts", async () => {
  await addMessages([{ text: "first" }, { text: "retry of first" }]);

  const rows = allRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.text).toBe("first");
});

test("storeMessageStatement keeps the same ts in another app or channel", async () => {
  await addMessages([{}, { appId: OTHER_APP }, { channelId: GROUP }]);

  expect(allRows()).toHaveLength(3);
});

test("updateMessageText and deleteMessage change only the matching row", async () => {
  await addMessages([
    { text: "keep", ts: "1.000001" },
    { text: "edit me", ts: "1.000002" },
    { text: "delete me", ts: "1.000003" },
    { channelId: GROUP, text: "same ts elsewhere", ts: "1.000002" },
  ]);

  await updateMessageText(db, {
    appId: MAIN_APP,
    channelId: CHANNEL,
    text: "edited",
    ts: "1.000002",
  });
  await deleteMessage(db, {
    appId: MAIN_APP,
    channelId: CHANNEL,
    ts: "1.000003",
  });

  const texts = allRows()
    .map((row) => `${row.channelId}/${row.ts}=${row.text}`)
    .sort();
  expect(texts).toEqual([
    `${CHANNEL}/1.000001=keep`,
    `${CHANNEL}/1.000002=edited`,
    `${GROUP}/1.000002=same ts elsewhere`,
  ]);
});

test("updateMessageText and deleteMessage do nothing for an absent row", async () => {
  await addMessages([{ text: "keep", ts: "1.000001" }]);

  await updateMessageText(db, {
    appId: MAIN_APP,
    channelId: CHANNEL,
    text: "ghost",
    ts: "9.999999",
  });
  await deleteMessage(db, {
    appId: OTHER_APP,
    channelId: CHANNEL,
    ts: "1.000001",
  });

  const rows = allRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.text).toBe("keep");
});

test("purgeMessagesBefore removes only rows created before the cutoff", async () => {
  const cutoff = new Date(
    Date.parse(at(0)) - MESSAGE_RETENTION_MS
  ).toISOString();
  await addMessages([
    {
      createdAt: new Date(Date.parse(cutoff) - 60_000).toISOString(),
      text: "older than retention",
      ts: "1.000001",
    },
    { createdAt: cutoff, text: "at the cutoff", ts: "1.000002" },
    { createdAt: at(0), text: "recent", ts: "1.000003" },
  ]);

  await purgeMessagesBefore(db, cutoff);

  expect(
    allRows()
      .map((row) => row.text)
      .sort()
  ).toEqual(["at the cutoff", "recent"]);
});

test("findDueBatches returns a channel once its oldest unbatched message is old enough", async () => {
  await addMessages([
    { createdAt: at(0), ts: "1.000001" },
    { createdAt: at(3), ts: "1.000002" },
  ]);
  const oldest = idByTs("1.000001");

  expect(await findDueBatches(db, { before: at(-1) })).toEqual([]);
  // The newer message is 3 minutes old, but the oldest one decides.
  expect(await findDueBatches(db, { before: at(0) })).toEqual([
    {
      agentId: "a_main",
      appId: MAIN_APP,
      botUserId: "U0BOT",
      channelId: CHANNEL,
      firstMessageId: oldest,
      teamId: TEAM,
      workspaceId: WORKSPACE,
    },
  ]);
});

test("findDueBatches ignores batched rows and returns one entry per channel", async () => {
  await addMessages([
    { batchedAt: at(0), createdAt: at(0), ts: "1.000001" },
    { createdAt: at(1), ts: "1.000002" },
    { createdAt: at(2), ts: "1.000003" },
    { channelId: GROUP, createdAt: at(1), ts: "1.000004" },
    { channelId: GROUP, createdAt: at(2), ts: "1.000005" },
  ]);

  const due = await findDueBatches(db, { before: at(30) });

  expect(due.map((batch) => batch.channelId)).toEqual([CHANNEL, GROUP]);
  expect(due[0]?.firstMessageId).toBe(idByTs("1.000002"));
  expect(due[1]?.firstMessageId).toBe(idByTs("1.000004"));
});

test("findDueBatches ignores mentions-mode apps, revoked apps and inactive agents", async () => {
  await addMessages([
    { appId: MENTIONS_APP, createdAt: at(0), ts: "1.000001" },
    { appId: REVOKED_APP, createdAt: at(0), ts: "1.000002" },
    { appId: IDLE_APP, createdAt: at(0), ts: "1.000003" },
    { appId: OTHER_APP, createdAt: at(0), ts: "1.000004" },
  ]);

  const due = await findDueBatches(db, { before: at(30) });

  expect(due.map((batch) => batch.appId)).toEqual([OTHER_APP]);
});

test("findDueBatches sorts by the oldest message in each channel", async () => {
  await addMessages([
    { channelId: CHANNEL, createdAt: at(5), ts: "1.000001" },
    { channelId: GROUP, createdAt: at(1), ts: "1.000002" },
  ]);

  const due = await findDueBatches(db, { before: at(30) });

  expect(due.map((batch) => batch.channelId)).toEqual([GROUP, CHANNEL]);
});

test("unbatchedMessages returns the app's unbatched messages in the channel, oldest first", async () => {
  await addMessages([
    { createdAt: at(3), text: "third", ts: "1.000003" },
    { createdAt: at(1), text: "first", ts: "1.000002" },
    { createdAt: at(1), text: "tie-broken first", ts: "1.000001" },
    { batchedAt: at(2), createdAt: at(2), text: "batched", ts: "1.000004" },
    { channelId: GROUP, createdAt: at(1), text: "elsewhere", ts: "1.000005" },
    { appId: OTHER_APP, createdAt: at(1), text: "other app", ts: "1.000006" },
  ]);

  const rows = await unbatchedMessages(db, {
    appId: MAIN_APP,
    channelId: CHANNEL,
  });

  expect(rows.map((row) => row.text)).toEqual([
    "tie-broken first",
    "first",
    "third",
  ]);
});

test("unbatchedMessages is capped at BATCH_MESSAGES_MAX", async () => {
  const total = BATCH_MESSAGES_MAX + 5;
  await addMessages(
    Array.from({ length: total }, (_, i) => ({
      createdAt: at(i),
      text: `m${i}`,
      ts: `1.${String(i).padStart(6, "0")}`,
    }))
  );

  const rows = await unbatchedMessages(db, {
    appId: MAIN_APP,
    channelId: CHANNEL,
  });

  expect(rows).toHaveLength(BATCH_MESSAGES_MAX);
  expect(rows[0]?.text).toBe("m0");
  expect(rows.at(-1)?.text).toBe(`m${BATCH_MESSAGES_MAX - 1}`);
});

test("markBatchedStatements marks ids in chunks, across more than one statement", async () => {
  const total = 120;
  await addMessages(
    Array.from({ length: total }, (_, i) => ({
      createdAt: at(i),
      ts: `1.${String(i).padStart(6, "0")}`,
    }))
  );
  const ids = db
    .select({ id: slackMessages.id })
    .from(slackMessages)
    .all()
    .map((row) => row.id);

  const statements = markBatchedStatements(db, {
    batchedAt: at(200),
    ids,
  });
  expect(statements.length).toBeGreaterThan(1);
  await sqliteAtomic(db)(statements);

  const rows = allRows();
  expect(rows).toHaveLength(total);
  expect(rows.every((row) => row.batchedAt === at(200))).toBe(true);
});

test("markBatchedStatements returns no statements for no ids", () => {
  expect(markBatchedStatements(db, { batchedAt: at(1), ids: [] })).toEqual([]);
});

test("searchMessages filters by channel and never returns a DM row", async () => {
  await addMessages([
    { channelId: CHANNEL, text: "deploy notes" },
    { channelId: GROUP, text: "deploy notes group", ts: "1.000002" },
    { channelId: DM, text: "deploy notes dm", ts: "1.000003" },
  ]);

  const all = await searchMessages(db, searchInput({ query: "deploy" }));
  expect(all.map((hit) => hit.channelId).sort()).toEqual([CHANNEL, GROUP]);

  const one = await searchMessages(
    db,
    searchInput({ channelId: GROUP, query: "deploy" })
  );
  expect(one.map((hit) => hit.channelId)).toEqual([GROUP]);
  expect(
    await searchMessages(db, searchInput({ channelId: DM, query: "deploy" }))
  ).toEqual([]);
});

test("searchMessages requires every word, case-insensitively", async () => {
  await addMessages([
    { text: "Deploy on Friday", ts: "1.000001" },
    { text: "deploy on monday", ts: "1.000002" },
    { text: "friday only", ts: "1.000003" },
  ]);

  const hits = await searchMessages(
    db,
    searchInput({ query: "  DEPLOY   friday " })
  );

  expect(hits.map((hit) => hit.text)).toEqual(["Deploy on Friday"]);
});

test("searchMessages treats % and _ in the query literally", async () => {
  await addMessages([
    { text: "costs 100% more", ts: "1.000001" },
    { text: "costs 1000 more", ts: "1.000002" },
    { text: "set my_var now", ts: "1.000003" },
    { text: "set myXvar now", ts: "1.000004" },
    { text: "back\\slash here", ts: "1.000005" },
  ]);

  expect(
    (await searchMessages(db, searchInput({ query: "100%" }))).map(
      (hit) => hit.ts
    )
  ).toEqual(["1.000001"]);
  expect(
    (await searchMessages(db, searchInput({ query: "my_var" }))).map(
      (hit) => hit.ts
    )
  ).toEqual(["1.000003"]);
  expect(
    (await searchMessages(db, searchInput({ query: "\\slash" }))).map(
      (hit) => hit.ts
    )
  ).toEqual(["1.000005"]);
});

test("searchMessages filters by Slack user id and by linked email", async () => {
  db.insert(identityLinks)
    .values({
      clerkUserId: "user_dom",
      createdAt: at(0),
      email: "dom@example.com",
      externalUserId: "U2",
      id: "link_dom",
      provider: "slack",
      teamId: TEAM,
      workspaceId: WORKSPACE,
    })
    .run();
  await addMessages([
    { slackUserId: "U1", text: "status update", ts: "1.000001" },
    { slackUserId: "U2", text: "status update", ts: "1.000002" },
    { slackUserId: "U3", text: "status update", ts: "1.000003" },
  ]);

  const bySlackId = await searchMessages(
    db,
    searchInput({ person: "U1", query: "status" })
  );
  expect(bySlackId.map((hit) => hit.slackUserId)).toEqual(["U1"]);
  expect(bySlackId[0]?.clerkEmail).toBeNull();

  const byEmail = await searchMessages(
    db,
    searchInput({ person: "Dom@Example.com", query: "status" })
  );
  expect(byEmail.map((hit) => hit.slackUserId)).toEqual(["U2"]);
  expect(byEmail[0]?.clerkEmail).toBe("dom@example.com");
});

test("searchMessages filters by since and until, inclusive", async () => {
  await addMessages([
    { createdAt: at(0), text: "note", ts: "1.000001" },
    { createdAt: at(10), text: "note", ts: "1.000002" },
    { createdAt: at(20), text: "note", ts: "1.000003" },
  ]);

  const hits = await searchMessages(
    db,
    searchInput({ query: "note", since: at(10), until: at(20) })
  );

  expect(hits.map((hit) => hit.ts)).toEqual(["1.000003", "1.000002"]);
});

test("searchMessages never returns another app's rows", async () => {
  await addMessages([
    { text: "shared word", ts: "1.000001" },
    { appId: OTHER_APP, text: "shared word", ts: "1.000002" },
  ]);

  const hits = await searchMessages(db, searchInput({ query: "shared" }));

  expect(hits.map((hit) => hit.ts)).toEqual(["1.000001"]);
});

test("searchMessages returns newest first and honours the limit", async () => {
  const total = SEARCH_LIMIT_MAX + 5;
  await addMessages(
    Array.from({ length: total }, (_, i) => ({
      createdAt: at(i),
      text: "match",
      ts: `1.${String(i).padStart(6, "0")}`,
    }))
  );

  const two = await searchMessages(
    db,
    searchInput({ limit: 2, query: "match" })
  );
  expect(two.map((hit) => hit.ts)).toEqual([
    `1.${String(total - 1).padStart(6, "0")}`,
    `1.${String(total - 2).padStart(6, "0")}`,
  ]);

  const capped = await searchMessages(
    db,
    searchInput({ limit: 1000, query: "match" })
  );
  expect(capped).toHaveLength(SEARCH_LIMIT_MAX);
});

const searchInput = (
  overrides: Partial<Parameters<typeof searchMessages>[1]>
): Parameters<typeof searchMessages>[1] => ({
  appId: MAIN_APP,
  limit: 20,
  query: "",
  teamId: TEAM,
  workspaceId: WORKSPACE,
  ...overrides,
});
