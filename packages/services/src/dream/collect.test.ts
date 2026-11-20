import { expect, test } from "bun:test";
import { events } from "@repo/db/schema/events";
import { memoryChanges } from "@repo/db/schema/memory";
import { runRequests } from "@repo/db/schema/requests";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { skills, skillVersions } from "@repo/db/schema/skills";
import { eq } from "drizzle-orm";
import {
  AGENT, makeWorld, OTHER_AGENT, RUN, SESSION, USER_A, WORKSPACE,
} from "../memory/test-world.ts";
import { createEventsService } from "../events.ts";
import { createDreamCollector } from "./collect.ts";

const SINCE = "2026-11-20T10:00:00.000Z";
const at = (seconds: number) => new Date(Date.parse(SINCE) + seconds * 1000).toISOString();
const setup = () => {
  const world = makeWorld();
  const blobs = new Map<string, string>();
  const service = createEventsService({ db: world.db, blobs: {
    get: (key) => Promise.resolve(blobs.get(key) ?? null),
    put: (key, body) => { blobs.set(key, body); return Promise.resolve(); },
  } });
  const collector = createDreamCollector({ db: world.db, events: service });
  const message = (id: string, second: number, sessionId = SESSION.ui as string,
    extra: Partial<typeof events.$inferInsert> = {}) => world.db.insert(events).values({
      id, createdAt: at(second), workspaceId: WORKSPACE, agentId: AGENT,
      sessionId, runId: RUN.ui, actorId: USER_A, actorKind: "user",
      type: "message.user", payload: JSON.stringify({ text: id }), ...extra,
    }).run();
  return { ...world, ...collector, message, blobs };
};

test("collects messages, results, all request kinds, failures, interruptions and inferred resends in time order", async () => {
  const w = setup();
  w.message("before", -1);
  w.message("boundary", 0);
  w.message("user", 1);
  w.message("assistant", 2, SESSION.ui, { type: "message.assistant", actorKind: "agent", actorId: AGENT });
  w.db.update(runs).set({ status: "done", finishedAt: at(3), resultText: "task complete" }).where(eq(runs.id, RUN.ui)).run();
  w.db.update(runs).set({ status: "failed", finishedAt: at(4), error: "failure detail" }).where(eq(runs.id, RUN.mail)).run();
  w.db.update(runs).set({ status: "interrupted", finishedAt: at(5), error: "lease expired" }).where(eq(runs.id, RUN.peer)).run();
  w.db.update(runs).set({ status: "cancelled", finishedAt: at(6) }).where(eq(runs.id, RUN.privateA)).run();
  w.message("original", -1, SESSION.privateA, { runId: RUN.privateA });
  w.message("resend", 7, SESSION.privateA, { runId: null });
  for (const [index, kind] of (["approval", "question", "takeover"] as const).entries()) {
    w.db.insert(runRequests).values({ id: kind, workspaceId: WORKSPACE, agentId: AGENT,
      sessionId: SESSION.ui, runId: RUN.ui, kind, createdAt: at(-10), answeredAt: at(8 + index),
      expiresAt: at(100), toolName: "tool", toolUseId: kind, status: "answered",
      display: JSON.stringify({ question: "Proceed?" }), answer: JSON.stringify(kind === "approval" ? { decision: "deny", note: "too risky" } : { text: "answer" }),
    }).run();
  }
  const result = await w.collectSince(AGENT, SINCE);
  expect(result.items.map((item) => item.kind)).toEqual([
    "message", "message", "task_result", "failed_run", "interrupted_run", "message", "edit_resend", "request", "request", "request",
  ]);
  expect(result.items.find((item) => item.sourceId === "approval")).toMatchObject({ denied: true, sourceKind: "request" });
  expect(result.items.find((item) => item.kind === "edit_resend")?.text).toContain("original");
  expect(result.items.find((item) => item.kind === "failed_run")?.text).toContain("failure detail");
  expect(result.items.map((item) => item.createdAt)).toEqual(result.items.map((item) => item.createdAt).sort());
});

test("tags private UI and Slack sessions, outside mail, peer and external actors; loads blob payloads", async () => {
  const w = setup();
  w.message("ui", 1);
  w.db.update(sessions).set({ origin: "slack" }).where(eq(sessions.id, SESSION.privateA)).run();
  w.message("dm", 2, SESSION.privateA);
  w.message("mail", 3, SESSION.mail);
  w.message("peer", 4, SESSION.peer);
  w.message("external", 5, SESSION.ui, { actorKind: "peer", actorId: "connection" });
  w.blobs.set("payloads/blob", JSON.stringify({ text: "blob message" }));
  w.message("blob", 6, SESSION.ui, { payload: null, payloadRef: "payloads/blob" });
  const { items } = await w.collectSince(AGENT, SINCE);
  expect(items.slice(0, 2).map((item) => [item.scope, item.userId])).toEqual([["private", USER_A], ["private", USER_A]]);
  expect(items.slice(2, 5).map((item) => item.scope)).toEqual(["outside", "outside", "outside"]);
  expect(items.at(-1)?.text).toBe("blob message");
});

test("collects agent memory and rejected proposals at decision time, excludes dream output and other agents", async () => {
  const w = setup();
  for (const [id, writtenBy, status, agentId] of [
    ["note", "agent", "applied", AGENT], ["rejection", "agent", "rejected", AGENT],
    ["person-rejection", "person", "rejected", AGENT], ["dream", "dream", "rejected", AGENT],
    ["other", "agent", "applied", OTHER_AGENT],
  ] as const) {
    w.db.insert(memoryChanges).values({ id, agentId, workspaceId: WORKSPACE,
      createdAt: status === "rejected" ? at(-1) : at(1), decidedAt: status === "rejected" ? at(2) : null,
      action: "add", kind: "work", noteId: id, text: id, writtenBy, status,
      userScope: id === "note" ? USER_A : null, sourceKind: "session", sourceId: SESSION.mail,
    }).run();
  }
  w.db.insert(skills).values({ id: "skill", name: "skill", workspaceId: WORKSPACE,
    ownerAgentId: OTHER_AGENT, createdBy: USER_A, createdByKind: "user", createdAt: SINCE, updatedAt: SINCE }).run();
  for (const [id, authorId, number] of [["proposal", AGENT, 1], ["other-proposal", OTHER_AGENT, 2]] as const) {
    w.db.insert(skillVersions).values({ id, skillId: "skill", workspaceId: WORKSPACE,
      number, authorId, authorKind: "agent", authorRunId: RUN.mail, message: id,
      status: "rejected", createdAt: at(-1) }).run();
    w.message(`reject-${id}`, 3, SESSION.mail, { type: "skill.rejected", agentId: null,
      payload: JSON.stringify({ skillId: "skill", version: number }), actorKind: "user" });
  }
  const { items } = await w.collectSince(AGENT, SINCE);
  expect(items.map((item) => item.kind).sort()).toEqual(["memory_change", "memory_proposal", "memory_proposal", "skill_proposal"]);
  expect(items.find((item) => item.sourceId === "note")).toMatchObject({ scope: "private", userId: USER_A });
  expect(items.find((item) => item.sourceId === "rejection")?.scope).toBe("outside");
  expect(items.find((item) => item.kind === "skill_proposal")?.text).toContain("proposal");
});

test("caps newest first, returns oldest first, reports omissions and visible truncation", async () => {
  const w = setup();
  w.message("oldest", 1);
  w.message("middle", 2);
  w.message("newest", 3);
  const capped = await w.collectSince(AGENT, SINCE, { characterBudget: 12 });
  expect(capped.items.map((item) => item.text)).toEqual(["middle", "newest"]);
  expect(capped.leftOut).toMatchObject({ total: 1, byKind: { message: 1 }, characters: 6 });
  const truncated = await w.collectSince(AGENT, SINCE, { characterBudget: 3 });
  expect(truncated.items).toHaveLength(1);
  expect(truncated.items[0]).toMatchObject({ text: "new", truncated: true });
  expect(truncated.leftOut).toMatchObject({ total: 2, truncated: 1, characters: 15 });
  expect((await w.collectSince(AGENT, SINCE, { characterBudget: 0 })).leftOut.total).toBe(3);
  await expect(w.collectSince(AGENT, SINCE, { characterBudget: -1 })).rejects.toThrow();
});

test("empty windows and first dreams; agent and workspace evidence stay isolated", async () => {
  const w = setup();
  expect((await w.collectSince(AGENT, at(100))).items).toEqual([]);
  w.message("mine", 1);
  w.message("alien", 2, SESSION.ui, { agentId: OTHER_AGENT });
  expect((await w.collectSince(AGENT, null)).items.map((item) => item.text)).toEqual(["mine"]);
  expect((await w.collectSince(OTHER_AGENT, null)).items).toEqual([]);
  await expect(w.collectSince("missing", null)).rejects.toMatchObject({ code: "not_found" });
});
