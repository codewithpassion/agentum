import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService } from "./events.ts";
import type { Clock } from "./runs/types.ts";
import { createRunsService, type RunsService } from "./runs.ts";
import { createSessionsService, type SessionsService } from "./sessions.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";

const user = (userId: string, workspaceId = WORKSPACE): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});

type Db = ReturnType<typeof migrated>;

let db: Db;
let nowMs: number;
let runs: RunsService;
let sessions: SessionsService;
let agentId: string;

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

const send = (principal: Principal, text: string, externalKey?: string) =>
  runs.startRun(principal, {
    agentId,
    input: { text },
    session: { externalKey, origin: "ui" },
  });

beforeEach(async () => {
  db = migrated();
  nowMs = Date.parse(START);
  // Each call to now() moves one second, so runs and sessions sort by creation.
  const clock: Clock = {
    now: () => {
      nowMs += 1000;
      return new Date(nowMs);
    },
    sleep: () => Promise.resolve(),
  };
  const store = new Map<string, string>();
  const blobs = {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    put: (key: string, body: string) => {
      store.set(key, body);
      return Promise.resolve();
    },
  };
  const events = createEventsService({ blobs, db });
  const agents = createAgentsService({ db, events });
  insertWorkspace(WORKSPACE);
  insertWorkspace("w2");
  agentId = (
    await agents.create(user("u1"), {
      model: "m",
      name: "Fake",
      runtime: "fake",
    })
  ).id;
  runs = createRunsService({
    adapters: [],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: true,
    gateways: [],
  });
  sessions = createSessionsService({ db, events });
});

test("list shows the caller's sessions newest first, with title and status", async () => {
  const first = await send(user("u1"), "first question");
  const second = await send(user("u1"), "second question");

  const items = await sessions.list(user("u1"), { agentId });

  expect(items.map((item) => item.id)).toEqual([
    second.sessionId,
    first.sessionId,
  ]);
  expect(items[0]).toMatchObject({
    origin: "ui",
    status: "done",
    title: "second question",
  });
});

test("list takes the title from the first message and the status from the last run", async () => {
  const first = await send(user("u1"), "opening");
  const next = await send(user("u1"), "follow up", first.sessionId);
  db.update(runRows)
    .set({ status: "interrupted" })
    .where(eq(runRows.id, next.runId))
    .run();

  const [item] = await sessions.list(user("u1"), { agentId });

  expect(item).toMatchObject({ status: "interrupted", title: "opening" });
});

test("list hides another user's ui session and other workspaces' sessions", async () => {
  await send(user("u1"), "private");

  expect(await sessions.list(user("u2"), { agentId })).toEqual([]);
  expect(await sessions.list(user("u1", "w2"), { agentId })).toEqual([]);
});

test("transcript returns the messages and the latest run with its input text", async () => {
  const first = await send(user("u1"), "hello");
  await send(user("u1"), "again", first.sessionId);

  const result = await sessions.transcript(user("u1"), first.sessionId);

  expect(result.entries.map((entry) => entry.type)).toEqual([
    "message.user",
    "message.assistant",
    "message.user",
    "message.assistant",
  ]);
  expect(result.latestRun).toMatchObject({
    inputText: "again",
    resultText: "Echo: again",
    status: "done",
  });
  expect(result.session).toMatchObject({ agentId, id: first.sessionId });
});

test("transcript refuses a session of another user or another workspace", async () => {
  const started = await send(user("u1"), "hello");

  const errors = await Promise.all(
    [user("u2"), user("u1", "w2")].map((outsider) =>
      sessions
        .transcript(outsider, started.sessionId)
        .catch((caught: unknown) => caught)
    )
  );

  for (const error of errors) {
    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({ code: "not_found" });
  }
});

test("the system principal cannot read sessions", async () => {
  const error = await sessions
    .list({ kind: "system" }, { agentId })
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ForbiddenError);
});
