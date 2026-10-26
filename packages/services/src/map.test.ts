import { beforeEach, expect, test } from "bun:test";
import { agents } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { mapPositions } from "@repo/db/schema/map";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createMapService } from "./map.ts";
import type { RequestRecord } from "./requests.ts";
import type { Principal } from "./workspaces.ts";

const now = "2026-10-27T12:00:00.000Z";
const edge = "2026-10-20T12:00:00.000Z";
const user: Principal = { kind: "user", userId: "u", via: "session", workspaceId: "w" };
let db: ReturnType<typeof migrated>;
let pending: RequestRecord[];
const graph = () => createMapService({ db, clock: { now: () => new Date(now), sleep: async () => {} }, requests: { listPending: async () => pending } }).graph(user, { days: 7 });
let seq = 0;
const event = async (type: string, agentId = "a", payload = {}, extra = {}) => {
  await db.insert(events).values({ id: `e${seq++}`, workspaceId: "w", actorId: "t", actorKind: "trigger", agentId, type, payload: JSON.stringify(payload), createdAt: now, ...extra });
};
beforeEach(async () => {
  db = migrated(); pending = []; seq = 0;
  await db.insert(workspaces).values(["w", "other"].map(id => ({ id, clerkOrgId: id, name: id, createdAt: now })));
  await db.insert(agents).values(["a", "b", "foreign", "draft", "archived"].map(id => ({ id, workspaceId: id === "foreign" ? "other" : "w", slug: id, name: id, createdBy: "u", instructions: "", model: "m", runtime: "fake" as const, runtimeConfig: id === "b" ? '{"browser":false}' : '{}', status: ["draft", "archived"].includes(id) ? id : "active", handsTo: id === "a" ? '["b"]' : '[]', createdAt: now })));
  await db.insert(triggers).values(["t", "idle", "revoked"].map(id => ({ id, workspaceId: "w", agentId: "a", name: id, kind: "http" as const, createdBy: "u", createdAt: now, revokedAt: id === "revoked" ? now : null })));
  await db.insert(sessions).values({ id: "s", workspaceId: "w", agentId: "a", actorId: "u", actorKind: "user", origin: "inbox", createdAt: now });
  await db.insert(runs).values([{ id: "parent", agentId: "a" }, { id: "child", agentId: "b", parentRunId: "parent" }, { id: "dry", agentId: "a", dryRun: true }].map(r => ({ ...r, workspaceId: "w", sessionId: "s", actorId: "u", actorKind: "user", inputText: "", status: "waiting" as const, createdAt: now })));
});
test("counts every wire kind and combines Q&A events", async () => {
  await event("trigger.fired"); await event("trigger.fired");
  await event("run.queued", "b", { origin: "inbox" }, { runId: "child" });
  await event("slack.message_sent", "a", { channel: "C1" });
  await event("library.write", "a", { path: "agents/a/tasks/child/result.md" });
  await event("library.write", "a", { path: "agents/a/notes.md" });
  await event("qa.asked"); await event("qa.answered"); await event("mail.sent");
  const result = await graph();
  expect(result.wires.map(w => [w.kind, w.count7d]).sort()).toEqual([["trigger", 2], ["trigger", 0], ["handoff", 1], ["slack", 1], ["library", 1], ["library", 1], ["qa", 2], ["email", 1]].sort());
  expect(result.nodes.map(n => n.key)).toContain("out:library:agents/a/tasks/child");
});
test("inclusive seven day edge, idle wires, dry runs and workspace isolation", async () => {
  await event("trigger.fired", "a", {}, { createdAt: edge });
  await event("trigger.fired", "a", {}, { createdAt: "2026-10-20T11:59:59.999Z" });
  await event("trigger.fired", "a", {}, { runId: "dry" });
  await event("trigger.fired", "foreign", {}, { workspaceId: "other" });
  const result = await graph();
  expect(result.wires.find(w => w.from === "trigger:t")?.count7d).toBe(1);
  expect(result.wires.find(w => w.from === "trigger:idle")).toMatchObject({ count7d: 0, active: false });
  expect(result.nodes.filter(n => n.kind === "agent").map(n => n.key)).toEqual(["agent:a", "agent:b"]);
  expect(result.nodes.some(n => n.key === "trigger:revoked")).toBe(false);
});
test("waiting record and saved positions win over deterministic columns", async () => {
  pending = [{ id: "request", agentId: "a", runId: "parent", display: { questions: [{ question: "Continue?" }] } } as RequestRecord];
  await db.insert(mapPositions).values({ workspaceId: "w", nodeKey: "agent:a", x: 123, y: 456, updatedAt: now });
  const result = await graph();
  expect(result.nodes.find(n => n.key === "agent:a")).toMatchObject({ x: 123, y: 456, waiting: true, pendingRequest: pending[0] });
  expect(result.nodes.find(n => n.key === "agent:b")?.ports).toEqual([]);
  expect(result.nodes.find(n => n.key === "agent:a")?.ports).toContainEqual({ id: "a", kind: "browser", label: "Browser" });
  expect(await graph()).toEqual(result);
});
