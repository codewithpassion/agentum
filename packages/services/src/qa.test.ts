import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  QA_BODY_MAX,
  QA_OPEN_PER_AGENT_MAX,
  QA_TITLE_MAX,
} from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService } from "./events.ts";
import { WAKE_LIMIT } from "./inbox/loop-guard.ts";
import { createQaService, QA_LIST_LIMIT } from "./qa.ts";
import { createRunsService } from "./runs.ts";
import type { Principal } from "./workspaces.ts";

const required = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("Expected fixture value");
  }
  return value;
};

const user = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
} as const;
const other = { ...user, userId: "u2", workspaceId: "w2" } as const;
const now = "2026-10-27T10:00:00.000Z";
let db: ReturnType<typeof migrated>;
let qa: ReturnType<typeof createQaService>;
let runs: ReturnType<typeof createRunsService>;
let agent: Extract<Principal, { kind: "run" }>;
let secondAgent: Extract<Principal, { kind: "run" }>;
const clock = { now: () => new Date(now), sleep: () => Promise.resolve() };
const blobs = {
  get: () => Promise.resolve(null),
  put: () => Promise.resolve(),
};

beforeEach(async () => {
  db = migrated();
  db.insert(workspaces)
    .values(
      ["w1", "w2"].map((id) => ({
        clerkOrgId: id,
        createdAt: now,
        id,
        name: id,
        timezone: "UTC",
      }))
    )
    .run();
  const atomic = sqliteAtomic(db);
  const events = createEventsService({ blobs, db });
  runs = createRunsService({
    adapters: [],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: true,
    gateways: [],
  });
  qa = createQaService({ atomic, clock, db, events, runs });
  const agents = createAgentsService({ db, events });
  const principals = await Promise.all(
    ["pelican", "tern"].map(async (slug) => {
      const row = await agents.create(user, {
        model: "fake",
        name: slug,
        runtime: "fake",
        slug,
      });
      const run = await runs.startRun(user, {
        agentId: row.id,
        input: { text: "start" },
        reply: { kind: "none" },
        session: { origin: "ui" },
      });
      return {
        agentId: row.id,
        kind: "run" as const,
        runId: run.runId,
        workspaceId: "w1",
      };
    })
  );
  agent = required(principals[0]);
  secondAgent = required(principals[1]);
});

const ask = (principal: Principal = user) =>
  qa.ask(principal, { body: "Which harbour?", title: "Where?" });

test("users and agents ask and answer with trusted authors and events", async () => {
  const personQuestion = await ask();
  const agentAnswer = await qa.answer(agent, {
    body: "Sydney",
    questionId: personQuestion.id,
  });
  const agentQuestion = await ask(agent);
  const personAnswer = await qa.answer(user, {
    body: "Melbourne",
    questionId: agentQuestion.id,
  });
  expect(personQuestion).toMatchObject({
    authorId: "u1",
    authorKind: "user",
    runId: null,
    status: "open",
  });
  expect(agentQuestion).toMatchObject({
    authorId: agent.agentId,
    authorKind: "agent",
    runId: agent.runId,
  });
  expect(agentAnswer).toMatchObject({
    authorId: agent.agentId,
    authorKind: "agent",
    runId: agent.runId,
  });
  expect((await qa.get(user, personQuestion.id)).answers).toEqual([
    agentAnswer,
  ]);
  expect((await qa.get(agent, agentQuestion.id)).answers).toEqual([
    personAnswer,
  ]);
  const events = db
    .select()
    .from(eventRows)
    .all()
    .filter((row) => row.type.startsWith("qa."));
  expect(events.map((row) => row.type)).toEqual([
    "qa.asked",
    "qa.answered",
    "qa.asked",
    "qa.answered",
  ]);
  expect(events[1]).toMatchObject({
    actorId: agent.agentId,
    actorKind: "agent",
    runId: agent.runId,
  });
  expect(events.every((row) => !(row.payload ?? "").includes("harbour"))).toBe(
    true
  );
});

test("accept validates the answer, marks answered and close records an event", async () => {
  const q = await ask(agent);
  const another = await ask();
  const a = await qa.answer(user, { body: "Yes", questionId: q.id });
  await expect(
    qa.accept(user, { answerId: a.id, questionId: another.id })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    qa.accept(secondAgent, { answerId: a.id, questionId: q.id })
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(
    await qa.accept(agent, { answerId: a.id, questionId: q.id })
  ).toMatchObject({ acceptedAnswerId: a.id, status: "answered" });
  expect(await qa.close(user, { questionId: q.id })).toMatchObject({
    status: "closed",
  });
  await expect(
    qa.answer(user, { body: "late", questionId: q.id })
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(
    qa.accept(user, { answerId: a.id, questionId: q.id })
  ).rejects.toMatchObject({ code: "conflict" });
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .filter((row) => ["qa.accepted", "qa.closed"].includes(row.type))
      .map((row) => row.type)
  ).toEqual(["qa.accepted", "qa.closed"]);
});

test("list filters and exclusive paging are stable for equal timestamps", async () => {
  await Promise.all(Array.from({ length: QA_LIST_LIMIT + 2 }, () => ask()));
  const page = await qa.list(user, {});
  expect(page.questions).toHaveLength(QA_LIST_LIMIT);
  const next = await qa.list(user, { cursor: required(page.nextCursor) });
  expect(next.questions).toHaveLength(2);
  expect(next.nextCursor).toBeNull();
  expect(
    new Set(
      [...page.questions, ...next.questions].map((question) => question.id)
    ).size
  ).toBe(QA_LIST_LIMIT + 2);
  const q = await ask(agent);
  await qa.close(agent, { questionId: q.id });
  expect(
    (
      await qa.list(user, { author: agent.agentId, status: "closed" })
    ).questions.map((row) => row.id)
  ).toEqual([q.id]);
  expect((await qa.list(user, { status: "answered" })).questions).toEqual([]);
});

test("every operation is workspace scoped and read-only credentials cannot mutate", async () => {
  const q = await ask();
  const a = await qa.answer(user, { body: "here", questionId: q.id });
  expect((await qa.list(other, {})).questions).toEqual([]);
  expect(await qa.openCount(other)).toBe(0);
  await expect(qa.get(other, q.id)).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(
    qa.answer(other, { body: "no", questionId: q.id })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    qa.accept(other, { answerId: a.id, questionId: q.id })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(qa.close(other, { questionId: q.id })).rejects.toMatchObject({
    code: "not_found",
  });
  await Promise.all(
    [
      { ...user, apiKey: { access: "read" as const, id: "key" } },
      { ...user, oauthClient: { access: "read" as const, clientId: "client" } },
    ].map(async (reader) => {
      expect((await qa.get(reader, q.id)).question.id).toBe(q.id);
      await expect(ask(reader)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        qa.answer(reader, { body: "no", questionId: q.id })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        qa.accept(reader, { answerId: a.id, questionId: q.id })
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        qa.close(reader, { questionId: q.id })
      ).rejects.toBeInstanceOf(ForbiddenError);
    })
  );
  await expect(qa.list({ kind: "system" }, {})).rejects.toBeInstanceOf(
    ForbiddenError
  );
});

test("shared title and body limits reject empty and oversized input", async () => {
  await expect(qa.ask(user, { body: "ok", title: " " })).rejects.toThrow();
  await expect(
    qa.ask(user, { body: "ok", title: "x".repeat(QA_TITLE_MAX + 1) })
  ).rejects.toThrow();
  await expect(
    qa.ask(user, { body: "x".repeat(QA_BODY_MAX + 1), title: "ok" })
  ).rejects.toThrow();
  const q = await qa.ask(user, {
    body: "x".repeat(QA_BODY_MAX),
    title: "x".repeat(QA_TITLE_MAX),
  });
  await expect(
    qa.answer(user, { body: " ", questionId: q.id })
  ).rejects.toThrow();
  await expect(
    qa.answer(user, { body: "x".repeat(QA_BODY_MAX + 1), questionId: q.id })
  ).rejects.toThrow();
  expect(
    (await qa.answer(user, { body: "x".repeat(QA_BODY_MAX), questionId: q.id }))
      .body.length
  ).toBe(QA_BODY_MAX);
});

test("agent open cap survives concurrent asks and acceptance or closure frees a slot", async () => {
  const results = await Promise.allSettled(
    Array.from({ length: QA_OPEN_PER_AGENT_MAX + 3 }, () => ask(agent))
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(
    QA_OPEN_PER_AGENT_MAX
  );
  expect(await qa.openCount(user)).toBe(QA_OPEN_PER_AGENT_MAX);
  await expect(ask(agent)).rejects.toMatchObject({ code: "conflict" });
  const [q] = (await qa.list(user, { author: agent.agentId })).questions;
  const a = await qa.answer(user, {
    body: "answer",
    questionId: required(q).id,
  });
  expect(await qa.openCount(agent)).toBe(QA_OPEN_PER_AGENT_MAX);
  await qa.accept(agent, { answerId: a.id, questionId: required(q).id });
  await ask(agent);
  await qa.close(agent, { questionId: required(q).id });
  const [open] = (
    await qa.list(user, { author: agent.agentId, status: "open" })
  ).questions;
  await qa.close(agent, { questionId: required(open).id });
  await ask(agent);
  await ask(secondAgent);
  await Promise.all(
    Array.from({ length: QA_OPEN_PER_AGENT_MAX + 1 }, () => ask(user))
  );
});

test("answer wakes the question agent in a per-question qa session and skips self-wakes", async () => {
  const q = await ask(agent);
  await qa.answer(agent, { body: "thinking", questionId: q.id });
  expect(db.select().from(runRows).all()).toHaveLength(2);
  await qa.answer(secondAgent, { body: "Use Sydney", questionId: q.id });
  const wakes = db
    .select()
    .from(runRows)
    .all()
    .filter((row) => row.parentRunId === secondAgent.runId);
  expect(wakes).toHaveLength(1);
  expect(wakes[0]).toMatchObject({
    agentId: agent.agentId,
    reply: JSON.stringify({ kind: "none" }),
  });
  expect(required(wakes[0]).inputText).toContain(q.title);
  expect(required(wakes[0]).inputText).toContain(q.body);
  expect(required(wakes[0]).inputText).toContain("Use Sydney");
  expect(
    db
      .select()
      .from(sessions)
      .where(eq(sessions.id, required(required(wakes[0]).sessionId)))
      .get()
  ).toMatchObject({ externalKey: `qa:${q.id}`, origin: "qa" });
});

test("rate budget persists across service instances and records suppressed wakes", async () => {
  const q = await ask(agent);
  for (let i = 0; i < WAKE_LIMIT + 1; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: exercise the persistent wake ledger
    await createQaService({
      atomic: sqliteAtomic(db),
      clock,
      db,
      events: createEventsService({ blobs, db }),
      runs,
    }).answer(user, { body: `answer ${i}`, questionId: q.id });
  }
  expect(db.select().from(runRows).all()).toHaveLength(2 + WAKE_LIMIT);
  expect(
    db
      .select()
      .from(eventRows)
      .all()
      .filter((row) => row.type === "inbox.loop_stopped")
  ).toHaveLength(1);
});

test("a busy/depth refusal is recorded without failing the answer", async () => {
  const events = createEventsService({ blobs, db });
  qa = createQaService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    runs: {
      startRun: () =>
        Promise.reject(new ServiceError("conflict", "Agent busy")),
    },
  });
  const q = await ask(agent);
  const a = await qa.answer(user, {
    body: "Saved despite refusal",
    questionId: q.id,
  });
  expect((await qa.get(user, q.id)).answers).toEqual([a]);
  const stop = db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "inbox.loop_stopped"))
    .get();
  expect(JSON.parse(required(required(stop).payload))).toMatchObject({
    answerId: a.id,
    questionId: q.id,
    reason: "refused",
  });
});
