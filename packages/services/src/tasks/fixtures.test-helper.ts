import type { EventRecord } from "../events.ts";
import type { RunRecord } from "../runs/types.ts";

export const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  actor: { id: "user", kind: "user" }, agentId: "agent", claimedBy: null,
  createdAt: "2026-10-26T00:00:00Z", depth: 0, error: null, finishedAt: null,
  id: "run", inputFileIds: [], inputText: "Hello", leaseUntil: null,
  onBehalfOfUserId: null, outputFileIds: [], parentRunId: null, pendingFiles: null,
  processEndedAt: null, reply: { kind: "none" }, requestId: null, resultText: null,
  sessionId: "session", startedAt: null, status: "running", usage: null,
  workspaceId: "workspace", ...overrides,
});
export const event = (type: EventRecord["type"], payload: EventRecord["payload"] = {}, id = type): EventRecord => ({
  actor: { id: "agent", kind: "agent" }, agentId: "agent", createdAt: "2026-10-26T00:00:00Z",
  id, payload, payloadRef: null, runId: "run", seq: null, sessionId: "session", type, workspaceId: "workspace",
});
export const call = (id: string, name = "web_search", input = {}) => event("tool.call", { input, name, toolUseId: id }, `call-${id}`);
export const result = (id: string, output: string, ok = true) => event("tool.result", { ok, output, toolUseId: id }, `result-${id}`);
