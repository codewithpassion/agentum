/** One isolated run's persisted state machine. Every external effect has a
 * persisted intent and a stable call id; room suggestions deduplicate that id. */
import type { RequestOutcome } from "@repo/protocol/requests";
import { questionSchema } from "@repo/protocol/requests";
import type { RunEventInput, RunRecord } from "@repo/services/runs/types";
import { z } from "zod";

export const guestReplySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer"), text: z.string().max(100_000) }),
  z.strictObject({
    input: z
      .record(z.string(), z.unknown())
      .refine((v) => JSON.stringify(v).length <= 8192),
    kind: z.literal("tool"),
    name: z.string().min(1).max(100),
  }),
  z.strictObject({
    kind: z.literal("question"),
    questions: z.array(questionSchema).min(1).max(5),
  }),
]);
export interface GuestTool {
  inputSchema: Record<string, unknown>;
  name: string;
}
type Reply = z.infer<typeof guestReplySchema>;
export class GuestContractError extends Error {}
export interface GuestExecutionState {
  failures?: number;
  history: Array<{ call: Reply; output: unknown }>;
  pending?: Reply;
  phase: "model" | "approval" | "effect" | "answer" | "done";
  requestId?: string;
  runId: string;
  seq: number;
  turn: number;
}
export interface GuestRunStore {
  alarm: (at: number) => Promise<void>;
  get: () => Promise<GuestExecutionState | undefined>;
  put: (state: GuestExecutionState) => Promise<void>;
}
export interface GuestRunCoreDeps {
  claim: (runId: string) => Promise<boolean>;
  complete: (runId: string, text: string) => Promise<void>;
  execution: (runId: string) => Promise<{ run: RunRecord; model: string }>;
  heartbeat: (runId: string) => Promise<void>;
  infer: (input: {
    context?: string;
    model: string;
    text: string;
    tools: GuestTool[];
    history: GuestExecutionState["history"];
  }) => Promise<unknown>;
  ingest: (runId: string, events: RunEventInput[]) => Promise<void>;
  invoke: (
    run: RunRecord,
    name: string,
    input: Record<string, unknown>,
    callId: string
  ) => Promise<unknown>;
  now: () => number;
  open: (
    run: RunRecord,
    reply: Reply,
    callId: string
  ) => Promise<{ id: string }>;
  outcome: (requestId: string) => Promise<RequestOutcome | null>;
  store: GuestRunStore;
  tools: (run: RunRecord) => Promise<GuestTool[]>;
}
const supported = new Set([
  "document_read",
  "document_comments",
  "document_comment",
  "deck_comments",
  "deck_comment",
  "document_edit",
  "deck_read",
  "deck_write",
]);
const terminal = new Set(["done", "failed", "cancelled", "interrupted"]);
const allowed = (outcome: RequestOutcome) =>
  outcome.status === "answered" &&
  "decision" in outcome.answer &&
  ["allow_once", "always_allow"].includes(outcome.answer.decision);
export const createGuestRunCore = (deps: GuestRunCoreDeps) => {
  const start = async (runId: string) => {
    const existing = await deps.store.get();
    if (existing && existing.runId !== runId) {
      throw new Error("Immutable guest run scope");
    }
    if (!existing) {
      await deps.store.put({
        history: [],
        phase: "model",
        runId,
        seq: 0,
        turn: 0,
      });
    }
    if (existing?.phase !== "done") {
      await deps.store.alarm(deps.now() + 1);
    }
  };
  const next = (state: GuestExecutionState, call: Reply, output: unknown) => {
    state.history.push({ call, output });
    state.turn += 1;
    state.phase = "model";
    state.pending = undefined;
    state.requestId = undefined;
  };
  const modelStep = async (
    state: GuestExecutionState,
    run: RunRecord,
    model: string
  ) => {
    if (state.turn >= 20) {
      throw new GuestContractError("Guest turn limit reached");
    }
    const tools = (await deps.tools(run)).filter((tool) =>
      supported.has(tool.name)
    );
    const reply = guestReplySchema.parse(
      await deps.infer({
        history: state.history,
        model,
        text: run.inputText,
        tools,
      })
    );
    await deps.execution(state.runId);
    if (
      reply.kind === "tool" &&
      (!tools.some((tool) => tool.name === reply.name) ||
        reply.input.artifactId !== run.scopeArtifactId)
    ) {
      throw new GuestContractError("Guest tool scope refused");
    }
    state.pending = reply;
    state.phase = reply.kind === "answer" ? "answer" : "approval";
    await deps.store.put(state);
  };
  const approvalStep = async (
    state: GuestExecutionState,
    run: RunRecord,
    pending: Reply
  ) => {
    if (!state.requestId) {
      state.requestId = (
        await deps.open(run, pending, `${state.runId}:${state.turn}`)
      ).id;
      await deps.store.put(state);
    }
    const outcome = await deps.outcome(state.requestId);
    if (!outcome) {
      return;
    }
    await deps.execution(state.runId);
    if (pending.kind === "question" || !allowed(outcome)) {
      next(state, pending, outcome);
    } else {
      state.phase = "effect";
    }
    await deps.store.put(state);
  };
  const effectStep = async (
    state: GuestExecutionState,
    run: RunRecord,
    pending: Extract<Reply, { kind: "tool" }>
  ) => {
    const tools = await deps.tools(run);
    if (
      !(
        supported.has(pending.name) &&
        tools.some((tool) => tool.name === pending.name)
      ) ||
      pending.input.artifactId !== run.scopeArtifactId
    ) {
      throw new GuestContractError("Guest tool access ended");
    }
    const callId = `${state.runId}:${state.turn}`;
    await deps.ingest(state.runId, [
      {
        payload: {
          input: z.json().parse(pending.input),
          toolName: pending.name,
          toolUseId: callId,
        },
        seq: state.seq + 1,
        type: "tool.call",
      },
    ]);
    const raw = await deps.invoke(run, pending.name, pending.input, callId);
    const encoded = JSON.stringify(raw);
    const output =
      encoded.length > 64_000
        ? { text: encoded.slice(0, 64_000), truncated: true }
        : raw;
    await deps.ingest(state.runId, [
      {
        payload: {
          result: z.json().parse(output),
          toolName: pending.name,
          toolUseId: callId,
        },
        seq: state.seq + 2,
        type: "tool.result",
      },
    ]);
    state.seq += 2;
    await deps.execution(state.runId);
    next(state, pending, output);
    await deps.store.put(state);
  };
  const answerStep = async (
    state: GuestExecutionState,
    pending: Extract<Reply, { kind: "answer" }>
  ) => {
    await deps.ingest(state.runId, [
      {
        payload: { text: pending.text },
        seq: state.seq + 1,
        type: "message.assistant",
      },
    ]);
    await deps.complete(state.runId, pending.text);
    state.phase = "done";
    await deps.store.put(state);
  };
  const assertContract = (run: RunRecord) => {
    if (
      !run.scopeArtifactId ||
      run.actor.kind !== "guest" ||
      run.inputFileIds.length ||
      run.reply.kind !== "none"
    ) {
      throw new GuestContractError("Guest capability contract required");
    }
  };
  const assertLease = (run: RunRecord) => {
    if (!(Date.parse(run.leaseUntil ?? "") > deps.now())) {
      throw new GuestContractError("Guest lease expired");
    }
  };
  const admitExecution = async (state: GuestExecutionState) => {
    let execution = await deps.execution(state.runId);
    if (terminal.has(execution.run.status)) {
      state.phase = "done";
      await deps.store.put(state);
      return null;
    }
    if (["queued", "offered"].includes(execution.run.status)) {
      if (!(await deps.claim(state.runId))) {
        await deps.store.alarm(deps.now() + 15_000);
        return null;
      }
      execution = await deps.execution(state.runId);
    }
    assertLease(execution.run);
    await deps.heartbeat(state.runId);
    assertContract(execution.run);
    return execution;
  };
  const step = async () => {
    const state = await deps.store.get();
    if (!state || state.phase === "done") {
      return;
    }
    await deps.store.alarm(deps.now() + 2000);
    const execution = await admitExecution(state);
    if (!execution) {
      return;
    }
    const { run, model } = execution;
    if (state.phase === "model") {
      return modelStep(state, run, model);
    }
    const { pending } = state;
    if (!pending) {
      throw new GuestContractError("Missing persisted guest intent");
    }
    if (state.phase === "approval") {
      return approvalStep(state, run, pending);
    }
    if (state.phase === "effect" && pending.kind === "tool") {
      return effectStep(state, run, pending);
    }
    if (state.phase === "answer" && pending.kind === "answer") {
      return answerStep(state, pending);
    }
    throw new GuestContractError("Guest phase mismatch");
  };
  return { start, step };
};
