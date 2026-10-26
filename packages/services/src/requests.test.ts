import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { eq } from "drizzle-orm";
import { createAgentsService } from "./agents.ts";
import { createEventsService } from "./events.ts";
import { createRequestsService } from "./requests.ts";
import { createRunsService } from "./runs.ts";
import type { RuntimeAdapter } from "./runs/types.ts";
import { SYSTEM_PRINCIPAL as system } from "./workspaces.ts";

const user = { kind: "user", userId: "u1", via: "session", workspaceId: "w1" } as const;
let db: ReturnType<typeof migrated>;
let now: number;
let resumed: string[];
let requests: ReturnType<typeof createRequestsService>;
let runs: ReturnType<typeof createRunsService>;
let agentId: string;
let opened: string[];

beforeEach(async () => {
  db = migrated();
  now = Date.parse("2026-10-26T00:00:00Z");
  resumed = [];
  opened = [];
  await db.insert(workspaces).values({ id: "w1", clerkOrgId: "org1", name: "Test" });
  const clock = { now: () => new Date(now), sleep: (ms: number) => { now += ms; return Promise.resolve(); } };
  const blobs = { get: () => Promise.resolve(null), put: () => Promise.resolve() };
  const events = createEventsService({ db, blobs });
  events.onAppend(async (event) => { opened.push(event.type); });
  const adapter: RuntimeAdapter = { kind: "cloud", cancel: async () => {}, dispatch: async () => {}, resume: async (_run, request) => { resumed.push(request.id); } };
  runs = createRunsService({ db, atomic: sqliteAtomic(db), blobs, clock, adapters: [adapter], gateways: [] });
  const agents = createAgentsService({ db });
  agentId = (await agents.create(user, { name: "Cloud", model: "m", runtime: "cloud" })).id;
  requests = createRequestsService({ db, atomic: sqliteAtomic(db), clock, events, runs, secrets: { maskerFor: async () => createMasker({ NAME: "granted-value-123" }) } });
});

const start = async () => {
  const run = await runs.startRun(user, { agentId, input: { text: "go" }, session: { origin: "ui" } });
  await runs.claimRun(system, run.runId);
  return run.runId;
};
const open = (runId: string, toolUseId = "call1") => requests.open(system, { runId, kind: "approval", toolUseId, toolName: "bash", toolKey: "bash", input: { command: "echo sk-12345678901234567890 granted-value-123" } });
const answer = (requestId: string) => requests.answer(user, { requestId, answer: { decision: "allow_once" }, via: "web" });
const status = async (id: string) => (await db.select().from(runRows).where(eq(runRows.id, id)))[0]?.status;

test("open is idempotent, redacts display and announces waiting once", async () => {
  const runId = await start();
  const first = await open(runId);
  expect(await open(runId)).toEqual(first);
  expect(JSON.stringify(first.display)).toContain("[redacted]");
  expect(JSON.stringify(first.display)).toContain("[secret:NAME]");
  expect(await status(runId)).toBe("waiting");
  expect(opened.filter((type) => type === "request.opened")).toHaveLength(1);
  await answer(first.id);
  expect((await open(runId)).outcome?.status).toBe("answered");
});

test("the same tool use in two runs stays separate", async () => {
  const first = await open(await start());
  // A second queued run can be forced running here to model another runtime execution.
  const second = await runs.startRun(user, { agentId, input: { text: "go" }, session: { origin: "ui" } });
  await db.update(runRows).set({ status: "running" }).where(eq(runRows.id, second.runId));
  expect((await open(second.runId)).id).not.toBe(first.id);
});

test("the first surface wins, always allow changes the rule, and wake happens once", async () => {
  const runId = await start();
  await requests.setRule(user, { agentId, toolKey: "bash", mode: "ask" });
  expect(await requests.needsApproval(system, { runId, toolKey: "bash" })).toBe(true);
  const request = await open(runId);
  await requests.answer(user, { requestId: request.id, answer: { decision: "always_allow" }, via: "slack" });
  await expect(answer(request.id)).rejects.toMatchObject({ code: "conflict", message: "Already answered" });
  expect(await requests.needsApproval(system, { runId, toolKey: "bash" })).toBe(false);
  expect(resumed).toEqual([request.id]);
});

test("two pending requests keep waiting until both close", async () => {
  const runId = await start();
  const first = await open(runId);
  const second = await open(runId, "call2");
  await answer(first.id);
  expect(await status(runId)).toBe("waiting");
  await answer(second.id);
  expect(await status(runId)).toBe("running");
  expect(resumed).toEqual([first.id, second.id]);
});

test("expiry resumes once, cancellation closes requests, and hidden sessions are not found", async () => {
  const runId = await start();
  const request = await open(runId);
  const other = { ...user, userId: "other" };
  await expect(requests.answer(other, { requestId: request.id, answer: { decision: "deny" }, via: "web" })).rejects.toMatchObject({ code: "not_found" });
  now += 60 * 60_000 + 1;
  await requests.expireDue(system);
  await requests.expireDue(system);
  expect(await requests.outcome(system, request.id)).toEqual({ status: "expired" });
  expect(await status(runId)).toBe("running");
  expect(resumed).toEqual([request.id]);
  const next = await open(runId, "call2");
  await runs.cancelRun(user, runId);
  expect(await requests.outcome(system, next.id)).toEqual({ status: "cancelled" });
});

test("question answers are scrubbed, polling is capped, and only the claimer can open", async () => {
  const runId = await start();
  await expect(requests.open(user, { runId, kind: "question", toolUseId: "q", toolName: "ask_user", questions: [{ question: "Which?" }] })).rejects.toThrow();
  const request = await requests.open(system, { runId, kind: "question", toolUseId: "q", toolName: "ask_user", questions: [{ question: "Which?" }] });
  const before = now;
  expect(await requests.waitForOutcome(system, request.id, { waitMs: 30_000 })).toBeNull();
  expect(now - before).toBe(25_000);
  await requests.answer(user, { requestId: request.id, answer: { answers: { "Which?": "sk-12345678901234567890" } }, via: "web" });
  expect(JSON.stringify(await requests.outcome(system, request.id))).toContain("[redacted]");
});
