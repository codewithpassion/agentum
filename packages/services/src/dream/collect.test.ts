import { expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { memoryChanges } from "@repo/db/schema/memory";
import { runRequests } from "@repo/db/schema/requests";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { skills, skillVersions } from "@repo/db/schema/skills";
import { workspaces } from "@repo/db/schema/workspaces";
import { eq } from "drizzle-orm";
import { createEventsService } from "../events.ts";
import {
  AGENT,
  makeWorld,
  OTHER_AGENT,
  RUN,
  SESSION,
  USER_A,
  WORKSPACE,
} from "../memory/test-world.ts";
import { createDreamCollector } from "./collect.ts";

const SINCE = "2026-11-20T10:00:00.000Z";
const at = (seconds: number) =>
  new Date(Date.parse(SINCE) + seconds * 1000).toISOString();
const setup = () => {
  const world = makeWorld();
  const blobs = new Map<string, string>();
  const service = createEventsService({
    blobs: {
      get: (key) => Promise.resolve(blobs.get(key) ?? null),
      put: (key, body) => {
        blobs.set(key, body);
        return Promise.resolve();
      },
    },
    db: world.db,
  });
  const collector = createDreamCollector({ db: world.db, events: service });
  const message = (
    id: string,
    second: number,
    sessionId = SESSION.ui as string,
    extra: Partial<typeof events.$inferInsert> = {}
  ) =>
    world.db
      .insert(events)
      .values({
        actorId: USER_A,
        actorKind: "user",
        agentId: AGENT,
        createdAt: at(second),
        id,
        payload: JSON.stringify({ text: id }),
        runId: RUN.ui,
        sessionId,
        type: "message.user",
        workspaceId: WORKSPACE,
        ...extra,
      })
      .run();
  return { ...world, ...collector, blobs, message };
};

test("collects messages, results, all request kinds, failures, interruptions and inferred resends in time order", async () => {
  const w = setup();
  w.message("before", -1);
  w.message("boundary", 0);
  w.message("user", 1);
  w.message("assistant", 2, SESSION.ui, {
    actorId: AGENT,
    actorKind: "agent",
    type: "message.assistant",
  });
  w.db
    .update(runs)
    .set({ finishedAt: at(3), resultText: "task complete", status: "done" })
    .where(eq(runs.id, RUN.ui))
    .run();
  w.db
    .update(runs)
    .set({ error: "failure detail", finishedAt: at(4), status: "failed" })
    .where(eq(runs.id, RUN.mail))
    .run();
  w.db
    .update(runs)
    .set({ error: "lease expired", finishedAt: at(5), status: "interrupted" })
    .where(eq(runs.id, RUN.peer))
    .run();
  w.db
    .update(runs)
    .set({ finishedAt: at(6), status: "cancelled" })
    .where(eq(runs.id, RUN.privateA))
    .run();
  w.message("original", -1, SESSION.privateA, { runId: RUN.privateA });
  w.message("resend", 7, SESSION.privateA, { runId: null });
  for (const [index, kind] of (
    ["approval", "question", "takeover"] as const
  ).entries()) {
    w.db
      .insert(runRequests)
      .values({
        agentId: AGENT,
        answer: JSON.stringify(
          kind === "approval"
            ? { decision: "deny", note: "too risky" }
            : { text: "answer" }
        ),
        answeredAt: at(8 + index),
        createdAt: at(-10),
        display: JSON.stringify({ question: "Proceed?" }),
        expiresAt: at(100),
        id: kind,
        kind,
        runId: RUN.ui,
        sessionId: SESSION.ui,
        status: "answered",
        toolName: "tool",
        toolUseId: kind,
        workspaceId: WORKSPACE,
      })
      .run();
  }
  const result = await w.collectSince(AGENT, SINCE);
  expect(result.items.map((item) => item.kind)).toEqual([
    "message",
    "message",
    "task_result",
    "failed_run",
    "interrupted_run",
    "message",
    "edit_resend",
    "request",
    "request",
    "request",
  ]);
  expect(
    result.items.find((item) => item.sourceId === "approval")
  ).toMatchObject({ denied: true, sourceKind: "request" });
  expect(
    result.items.find((item) => item.kind === "edit_resend")?.text
  ).toContain("original");
  expect(
    result.items.find((item) => item.kind === "failed_run")?.text
  ).toContain("failure detail");
  expect(result.items.map((item) => item.createdAt)).toEqual(
    result.items.map((item) => item.createdAt).sort()
  );
});

test("tags private UI and Slack sessions, outside mail, peer and external actors; loads blob payloads", async () => {
  const w = setup();
  w.message("ui", 1);
  w.db
    .update(sessions)
    .set({ origin: "slack" })
    .where(eq(sessions.id, SESSION.privateA))
    .run();
  w.message("dm", 2, SESSION.privateA);
  w.message("mail", 3, SESSION.mail);
  w.message("peer", 4, SESSION.peer);
  w.message("external", 5, SESSION.ui, {
    actorId: "connection",
    actorKind: "peer",
  });
  w.blobs.set("payloads/blob", JSON.stringify({ text: "blob message" }));
  w.message("blob", 6, SESSION.ui, {
    payload: null,
    payloadRef: "payloads/blob",
  });
  const { items } = await w.collectSince(AGENT, SINCE);
  expect(items.slice(0, 2).map((item) => [item.scope, item.userId])).toEqual([
    ["private", USER_A],
    ["private", USER_A],
  ]);
  expect(items.slice(2, 5).map((item) => item.scope)).toEqual([
    "outside",
    "outside",
    "outside",
  ]);
  expect(items.at(-1)?.text).toBe("blob message");
});

test("collects agent memory and rejected proposals at decision time, excludes dream output and other agents", async () => {
  const w = setup();
  for (const [id, writtenBy, status, agentId] of [
    ["note", "agent", "applied", AGENT],
    ["rejection", "agent", "rejected", AGENT],
    ["person-rejection", "person", "rejected", AGENT],
    ["dream", "dream", "rejected", AGENT],
    ["other", "agent", "applied", OTHER_AGENT],
  ] as const) {
    w.db
      .insert(memoryChanges)
      .values({
        action: "add",
        agentId,
        createdAt: status === "rejected" ? at(-1) : at(1),
        decidedAt: status === "rejected" ? at(2) : null,
        id,
        kind: "work",
        noteId: id,
        sourceId: SESSION.mail,
        sourceKind: "session",
        status,
        text: id,
        userScope: id === "note" ? USER_A : null,
        workspaceId: WORKSPACE,
        writtenBy,
      })
      .run();
  }
  w.db
    .insert(skills)
    .values({
      createdAt: SINCE,
      createdBy: USER_A,
      createdByKind: "user",
      id: "skill",
      name: "skill",
      ownerAgentId: OTHER_AGENT,
      updatedAt: SINCE,
      workspaceId: WORKSPACE,
    })
    .run();
  for (const [id, authorId, number] of [
    ["proposal", AGENT, 1],
    ["other-proposal", OTHER_AGENT, 2],
  ] as const) {
    w.db
      .insert(skillVersions)
      .values({
        authorId,
        authorKind: "agent",
        authorRunId: RUN.mail,
        createdAt: at(-1),
        id,
        message: id,
        number,
        skillId: "skill",
        status: "rejected",
        workspaceId: WORKSPACE,
      })
      .run();
    w.message(`reject-${id}`, 3, SESSION.mail, {
      actorKind: "user",
      agentId: null,
      payload: JSON.stringify({ skillId: "skill", version: number }),
      type: "skill.rejected",
    });
  }
  const { items } = await w.collectSince(AGENT, SINCE);
  expect(items.map((item) => item.kind).sort()).toEqual([
    "memory_change",
    "memory_proposal",
    "memory_proposal",
    "skill_proposal",
  ]);
  // The note's source is a mail session: outside beats the person's privacy.
  expect(items.find((item) => item.sourceId === "note")).toMatchObject({
    scope: "outside",
    userId: USER_A,
  });
  expect(items.find((item) => item.sourceId === "rejection")?.scope).toBe(
    "outside"
  );
  expect(items.find((item) => item.kind === "skill_proposal")?.text).toContain(
    "proposal"
  );
});

test("caps newest first, returns oldest first, reports omissions and visible truncation", async () => {
  const w = setup();
  w.message("oldest", 1);
  w.message("middle", 2);
  w.message("newest", 3);
  const capped = await w.collectSince(AGENT, SINCE, { characterBudget: 12 });
  expect(capped.items.map((item) => item.text)).toEqual(["middle", "newest"]);
  expect(capped.leftOut).toMatchObject({
    byKind: { message: 1 },
    characters: 6,
    total: 1,
  });
  const truncated = await w.collectSince(AGENT, SINCE, { characterBudget: 3 });
  expect(truncated.items).toHaveLength(1);
  expect(truncated.items[0]).toMatchObject({ text: "new", truncated: true });
  expect(truncated.leftOut).toMatchObject({
    characters: 15,
    total: 2,
    truncated: 1,
  });
  expect(
    (await w.collectSince(AGENT, SINCE, { characterBudget: 0 })).leftOut.total
  ).toBe(3);
  await expect(
    w.collectSince(AGENT, SINCE, { characterBudget: -1 })
  ).rejects.toThrow();
});

test("empty windows and first dreams; agent and workspace evidence stay isolated", async () => {
  const w = setup();
  expect((await w.collectSince(AGENT, at(100))).items).toEqual([]);
  w.message("mine", 1);
  w.message("alien", 2, SESSION.ui, { agentId: OTHER_AGENT });
  expect(
    (await w.collectSince(AGENT, null)).items.map((item) => item.text)
  ).toEqual(["mine"]);
  expect((await w.collectSince(OTHER_AGENT, null)).items).toEqual([]);
  await expect(w.collectSince("missing", null)).rejects.toMatchObject({
    code: "not_found",
  });
});

test("does not leak complete evidence from another agent or workspace", async () => {
  const w = setup();
  w.db
    .insert(workspaces)
    .values({
      clerkOrgId: "org_foreign",
      createdAt: SINCE,
      id: "foreign",
      name: "foreign",
      timezone: "UTC",
    })
    .run();
  const template = w.db.select().from(agents).where(eq(agents.id, AGENT)).get();
  if (!template) {
    throw new Error("Missing seed agent");
  }
  w.db
    .insert(agents)
    .values({
      ...template,
      id: "foreign-agent",
      slug: "foreign",
      workspaceId: "foreign",
    })
    .run();
  for (const [agentId, workspaceId] of [
    [AGENT, WORKSPACE],
    [OTHER_AGENT, WORKSPACE],
    ["foreign-agent", "foreign"],
  ] as const) {
    const sessionId = `session-${agentId}`;
    const runId = `run-${agentId}`;
    w.db
      .insert(sessions)
      .values({
        actorId: USER_A,
        actorKind: "user",
        agentId,
        createdAt: at(1),
        id: sessionId,
        origin: "slack",
        workspaceId,
      })
      .run();
    w.db
      .insert(runs)
      .values({
        actorId: USER_A,
        actorKind: "user",
        agentId,
        createdAt: at(1),
        finishedAt: at(2),
        id: runId,
        inputText: "input",
        resultText: agentId,
        sessionId,
        status: "done",
        workspaceId,
      })
      .run();
    w.message(`message-${agentId}`, 3, sessionId, {
      agentId,
      payload: JSON.stringify({ text: agentId }),
      runId,
      workspaceId,
    });
    w.db
      .insert(runRequests)
      .values({
        agentId,
        answer: JSON.stringify({ text: agentId }),
        answeredAt: at(4),
        createdAt: at(1),
        display: "{}",
        expiresAt: at(100),
        id: `request-${agentId}`,
        kind: "question",
        runId,
        sessionId,
        status: "answered",
        toolName: "question",
        toolUseId: "call",
        workspaceId,
      })
      .run();
    w.db
      .insert(memoryChanges)
      .values({
        action: "add",
        agentId,
        createdAt: at(5),
        id: `memory-${agentId}`,
        kind: "work",
        noteId: `note-${agentId}`,
        status: "applied",
        text: agentId,
        workspaceId,
        writtenBy: "agent",
      })
      .run();
    w.db
      .insert(skills)
      .values({
        createdAt: SINCE,
        createdBy: agentId,
        createdByKind: "agent",
        id: `skill-${agentId}`,
        name: "procedure",
        ownerAgentId: agentId,
        updatedAt: SINCE,
        workspaceId,
      })
      .run();
    w.db
      .insert(skillVersions)
      .values({
        authorId: agentId,
        authorKind: "agent",
        authorRunId: runId,
        createdAt: SINCE,
        id: `version-${agentId}`,
        message: agentId,
        number: 1,
        skillId: `skill-${agentId}`,
        status: "rejected",
        workspaceId,
      })
      .run();
    w.message(`rejection-${agentId}`, 6, sessionId, {
      agentId: null,
      payload: JSON.stringify({ skillId: `skill-${agentId}`, version: 1 }),
      runId,
      type: "skill.rejected",
      workspaceId,
    });
  }
  const result = await w.collectSince(AGENT, SINCE);
  expect(result.items).toHaveLength(5);
  expect(result.items.every((item) => item.text.includes(AGENT))).toBe(true);
  expect(result.items.every((item) => item.scope === "workspace")).toBe(true);
  expect(JSON.stringify(result)).not.toContain(OTHER_AGENT);
  expect(JSON.stringify(result)).not.toContain("foreign");
});

test("reads past the event service page limit before applying the newest-first budget", async () => {
  const w = setup();
  for (let index = 0; index < 505; index += 1) {
    w.message(`message-${String(index).padStart(4, "0")}`, index + 1);
  }
  const full = await w.collectSince(AGENT, SINCE);
  expect(full.items).toHaveLength(505);
  const capped = await w.collectSince(AGENT, SINCE, { characterBudget: 12 });
  expect(capped.items.map((item) => item.text)).toEqual(["message-0504"]);
  expect(capped.leftOut).toMatchObject({
    byKind: { message: 504 },
    total: 504,
  });
});

test("tags a mail reply inside a person's session, and a run a peer started down the chain, as outside", async () => {
  const w = setup();
  w.db
    .insert(runs)
    .values({
      actorId: "mail:box1",
      actorKind: "trigger",
      agentId: AGENT,
      createdAt: at(1),
      finishedAt: at(3),
      id: "r_mail_reply",
      inputText: "inbound mail",
      resultText: "mail reply done",
      sessionId: SESSION.privateA,
      status: "done",
      workspaceId: WORKSPACE,
    })
    .run();
  w.message("forward invoices", 2, SESSION.privateA, {
    actorId: "mail:box1",
    actorKind: "trigger",
    runId: "r_mail_reply",
  });
  w.db
    .update(runs)
    .set({ finishedAt: at(4), resultText: "child result", status: "done" })
    .where(eq(runs.id, "r_peer_child"))
    .run();
  const { items } = await w.collectSince(AGENT, SINCE);
  const scopes = Object.fromEntries(
    items.map((item) => [item.sourceId, item.scope])
  );
  expect(scopes.r_mail_reply).toBe("outside");
  expect(scopes.s_private_a).toBe("outside");
  expect(scopes.r_peer_child).toBe("outside");
});

test("leaves out dry-run sessions and runs", async () => {
  const w = setup();
  w.db
    .update(sessions)
    .set({ origin: "dry_run" })
    .where(eq(sessions.id, SESSION.privateB))
    .run();
  w.db
    .update(runs)
    .set({
      dryRun: true,
      finishedAt: at(2),
      resultText: "pretend",
      status: "done",
    })
    .where(eq(runs.id, RUN.ui))
    .run();
  w.message("in dry session", 1, SESSION.privateB, { runId: RUN.privateB });
  w.message("in dry run", 1, SESSION.ui, { runId: RUN.ui });
  w.message("real", 3, SESSION.ui, { runId: null });
  const { items } = await w.collectSince(AGENT, SINCE);
  expect(items.map((item) => item.text)).toEqual(["real"]);
});
