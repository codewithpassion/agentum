import type { Database } from "@repo/db";
import type { AgentRuntime, EventActorKind, RunStatus } from "@repo/db/shared";
import { z } from "zod";
import type { AgentRecord } from "../agents.ts";
import type { Payload } from "../events/payload.ts";
import type { Principal } from "../workspaces.ts";

/** Time, injected so tests can move it. `sleep` is what `waitForRun` polls with. */
export interface Clock {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export const SESSION_ORIGINS = [
  "ui",
  "slack",
  "inbox",
  "routine",
  "trigger",
  "mcp",
] as const;
export type SessionOrigin = (typeof SESSION_ORIGINS)[number];

const idString = z.string().min(1).max(200);

/** Where the answer goes when the run finishes. */
export const replyTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    channel: idString,
    kind: z.literal("slack"),
    teamId: idString,
    threadTs: idString,
  }),
  z.strictObject({ kind: z.literal("inbox"), threadId: idString }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type ReplyTarget = z.infer<typeof replyTargetSchema>;

export const INPUT_TEXT_MAX = 100_000;
export const INPUT_FILES_MAX = 20;

/** There is no actor field: `startRun` derives it from the principal. */
export const startRunInputSchema = z.strictObject({
  agentId: idString,
  input: z.strictObject({
    fileIds: z.array(idString).max(INPUT_FILES_MAX).default([]),
    text: z.string().min(1).max(INPUT_TEXT_MAX),
  }),
  reply: replyTargetSchema.default({ kind: "none" }),
  requestId: idString.optional(),
  session: z.strictObject({
    externalKey: idString.optional(),
    origin: z.enum(SESSION_ORIGINS),
  }),
});
export type StartRunInput = z.input<typeof startRunInputSchema>;

export const usageSchema = z.looseObject({
  costUsd: z.number().min(0).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
});
export type Usage = z.infer<typeof usageSchema>;

/** A run row with its JSON columns parsed. */
export interface RunRecord {
  actor: { id: string; kind: EventActorKind };
  agentId: string;
  claimedBy: string | null;
  createdAt: string;
  depth: number;
  error: string | null;
  finishedAt: string | null;
  id: string;
  inputFileIds: string[];
  inputText: string;
  leaseUntil: string | null;
  onBehalfOfUserId: string | null;
  outputFileIds: string[];
  parentRunId: string | null;
  /** Slack file descriptors not yet in R2. The shape belongs to the Slack gateway. */
  pendingFiles: unknown[] | null;
  processEndedAt: string | null;
  reply: ReplyTarget;
  requestId: string | null;
  resultText: string | null;
  sessionId: string;
  startedAt: string | null;
  status: RunStatus;
  usage: Usage | null;
  workspaceId: string;
}

/** What `waitForRun` and `getRun` hand back. */
export interface RunSummary {
  agentId: string;
  createdAt: string;
  error: string | null;
  finishedAt: string | null;
  id: string;
  outputFileIds: string[];
  processEndedAt: string | null;
  resultText: string | null;
  sessionId: string;
  status: RunStatus;
}

/** The statuses a run never leaves (an `interrupted` run only gains `process_ended_at`). */
export const TERMINAL_STATUSES: readonly RunStatus[] = [
  "done",
  "failed",
  "cancelled",
  "interrupted",
];

/** What an agent may append to its own run. */
export const RUN_EVENT_TYPES = [
  "message.assistant",
  "tool.call",
  "tool.result",
] as const;

export interface RunEventInput {
  payload: Payload;
  /** Position within the run, from 1. A seq at or below the stored `lastSeq` is skipped. */
  seq: number;
  type: (typeof RUN_EVENT_TYPES)[number];
}

export interface RunResult {
  error?: string;
  fileIds?: string[];
  /** The Claude Code session id, stored on the session. */
  runtimeRef?: string;
  /** `aborted` is only accepted for an `interrupted` run. */
  status: "done" | "failed" | "aborted";
  text?: string;
  usage?: Usage;
}

/**
 * What the service lends an adapter. Adapters that run in-process (fake,
 * later managed) use these; the machine adapter's daemon reaches the same
 * functions over HTTP.
 */
export interface AdapterDeps {
  claimRun: (principal: Principal, runId: string) => Promise<RunRecord>;
  clock: Clock;
  completeRun: (
    principal: Principal,
    runId: string,
    result: RunResult
  ) => Promise<void>;
  ingestRunEvents: (
    principal: Principal,
    runId: string,
    events: readonly RunEventInput[]
  ) => Promise<{ lastSeq: number }>;
}

export interface RuntimeAdapter {
  /** Stops the execution if there is one. Best effort. */
  cancel: (db: Database, run: RunRecord, deps: AdapterDeps) => Promise<void>;
  /** Fast: enqueue or offer. Only the fake runtime finishes the run in here. */
  dispatch: (
    db: Database,
    run: RunRecord,
    agent: AgentRecord,
    deps: AdapterDeps
  ) => Promise<void>;
  kind: AgentRuntime;
}

/** The trusted context `completeRun` gives a gateway. Never read from a post body. */
export interface DeliveryContext {
  agentId: string;
  onBehalfOfUserId: string | null;
  runId: string;
}

export interface Gateway {
  deliver: (
    target: ReplyTarget,
    message: { fileIds: string[]; text: string },
    context: DeliveryContext
  ) => Promise<void>;
  /**
   * Downloads Slack-style file descriptors into R2 and `files` rows, and
   * returns the new file ids. The sweep calls it for runs whose reply target
   * is this gateway's kind. Gateways with nothing to download leave it out.
   */
  downloadPendingFiles?: (
    descriptors: readonly unknown[],
    context: DeliveryContext & { workspaceId: string }
  ) => Promise<string[]>;
  kind: ReplyTarget["kind"];
}
