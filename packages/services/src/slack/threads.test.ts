import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { slackThreads } from "@repo/db/schema/slack";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import {
  findThreadSession,
  startedThreadStatement,
  type ThreadKey,
} from "./threads.ts";

const WORKSPACE = "w1";
const AGENT = "a1";
const START = "2026-10-16T10:00:00.000Z";
const TEAM = "T0TEAM";
const CHANNEL = "C0CHAN";
const THREAD = "1700000000.000100";
const MENTION_SESSION = "s-mention";
const STARTED_SESSION = "s-started";
const UI_SESSION = "s-ui";

let db: ReturnType<typeof migrated>;

const key = (overrides: Partial<ThreadKey> = {}): ThreadKey => ({
  agentId: AGENT,
  channelId: CHANNEL,
  teamId: TEAM,
  threadTs: THREAD,
  workspaceId: WORKSPACE,
  ...overrides,
});

const insertSession = (
  id: string,
  origin: string,
  externalKey: string | null
) =>
  db
    .insert(sessionRows)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: AGENT,
      createdAt: START,
      externalKey,
      id,
      origin,
      workspaceId: WORKSPACE,
    })
    .run();

beforeEach(() => {
  db = migrated();
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
  insertSession(MENTION_SESSION, "slack", `${TEAM}:${CHANNEL}:${THREAD}`);
  insertSession(STARTED_SESSION, "slack", `${TEAM}:C0OTHER:1700000000.000200`);
  insertSession(UI_SESSION, "ui", null);
});

test("findThreadSession returns the session of a thread the agent started", async () => {
  await sqliteAtomic(db)([
    startedThreadStatement(db, {
      agentId: AGENT,
      channelId: CHANNEL,
      createdAt: START,
      sessionId: STARTED_SESSION,
      teamId: TEAM,
      threadTs: THREAD,
      workspaceId: WORKSPACE,
    }),
  ]);

  expect(await findThreadSession(db, key())).toEqual({
    externalKey: `${TEAM}:C0OTHER:1700000000.000200`,
    origin: "slack",
    sessionId: STARTED_SESSION,
  });
});

test("findThreadSession finds a slack session by the mention key", async () => {
  expect(await findThreadSession(db, key())).toEqual({
    externalKey: `${TEAM}:${CHANNEL}:${THREAD}`,
    origin: "slack",
    sessionId: MENTION_SESSION,
  });
});

test("findThreadSession returns null when no thread or session matches", async () => {
  expect(
    await findThreadSession(db, key({ threadTs: "1700000000.999999" }))
  ).toBeNull();
  expect(await findThreadSession(db, key({ channelId: "C0NONE" }))).toBeNull();
  expect(await findThreadSession(db, key({ agentId: "other" }))).toBeNull();
});

test("findThreadSession returns null when the started thread's session has no external key", async () => {
  await sqliteAtomic(db)([
    startedThreadStatement(db, {
      agentId: AGENT,
      channelId: CHANNEL,
      createdAt: START,
      sessionId: UI_SESSION,
      teamId: TEAM,
      threadTs: THREAD,
      workspaceId: WORKSPACE,
    }),
  ]);

  expect(await findThreadSession(db, key())).toBeNull();
});

test("startedThreadStatement is idempotent on the same thread", async () => {
  const atomic = sqliteAtomic(db);
  await atomic([
    startedThreadStatement(db, {
      agentId: AGENT,
      channelId: CHANNEL,
      createdAt: START,
      sessionId: STARTED_SESSION,
      teamId: TEAM,
      threadTs: THREAD,
      workspaceId: WORKSPACE,
    }),
  ]);
  await atomic([
    startedThreadStatement(db, {
      agentId: AGENT,
      channelId: CHANNEL,
      createdAt: START,
      sessionId: MENTION_SESSION,
      teamId: TEAM,
      threadTs: THREAD,
      workspaceId: WORKSPACE,
    }),
  ]);

  const rows = db.select().from(slackThreads).all();
  expect(rows).toHaveLength(1);
  expect(rows[0]?.sessionId).toBe(STARTED_SESSION);
});
