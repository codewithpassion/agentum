import type { Database } from "@repo/db";
import type { Statement } from "@repo/db/atomic";
import {
  type AgentRuntime,
  type EventActorKind,
  INPUT_FILES_MAX,
  type RunStatus,
  SESSION_ORIGINS as SHARED_SESSION_ORIGINS,
} from "@repo/db/shared";
import type { RunStop } from "@repo/protocol/safeguards";
import { z } from "zod";
import type { AgentRecord } from "../agents.ts";
import type { Payload } from "../events/payload.ts";
import type { RequestRecord } from "../requests.ts";
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

/** Session origins; the browser router independently restricts starts to ui. */
export const SESSION_ORIGINS = SHARED_SESSION_ORIGINS;
/** Set in-process only (the agent builder's dry run), never by a browser client. */
export const DRY_RUN_ORIGIN = "dry_run" as const;
export type SessionOrigin =
  | (typeof SESSION_ORIGINS)[number]
  | typeof DRY_RUN_ORIGIN;

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
  z.strictObject({ kind: z.literal("a2a"), taskId: idString }),
  z.strictObject({ kind: z.literal("none") }),
]);
export type ReplyTarget = z.infer<typeof replyTargetSchema>;

export const INPUT_TEXT_MAX = 100_000;

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
    origin: z.enum([...SESSION_ORIGINS, DRY_RUN_ORIGIN]),
    private: z.boolean().optional(),
  }),
});
export type StartRunInput = z.input<typeof startRunInputSchema>;

export const usageSchema = z.looseObject({
  costUsd: z.number().min(0).optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
});
export type Usage = z.infer<typeof usageSchema>;

/**
 * What a trusted caller adds to `startRun`. It is not part of the input
 * schema, so nothing a client sends can reach it.
 */
export interface StartRunOptions {
  /**
   * Writes that land in the same atomic write as the session and the run,
   * after them. A failing one (a duplicate row) rolls the run back too.
   */
  alongside?: (ids: { runId: string; sessionId: string }) => Statement[];
  /**
   * A dry run reads and thinks, and skips every write. It runs on the cloud
   * runtime whatever the agent's runtime is, and may start on a `draft` agent.
   * It is not in `startRunInputSchema` on purpose: the browser schema is built
   * from that, so only a trusted in-process caller can ask for one.
   */
  dryRun?: boolean;
  /**
   * Answer as soon as the atomic write is done: the `run.queued` and
   * `message.user` events join it, and the run is not offered to its runtime.
   * The caller does that afterwards with `offerQueuedRun` (the minute sweep
   * does it for a run nobody offered).
   */
  offerLater?: boolean;
  /** File descriptors still to be fetched. The run is not claimable until they are. */
  pendingFiles?: unknown[];
  /**
   * Continue this session of the run's agent and workspace instead of finding
   * or opening one by `session.externalKey`. It skips the `ui` and private
   * actor check, so only a trusted caller that has decided who may continue
   * the session passes it (an inbound mail reply on an agent-started thread).
   * Not in `startRunInputSchema` on purpose. An unknown id is "not found".
   */
  sessionId?: string;
}

/** A run row with its JSON columns parsed. */
export interface RunRecord {
  actor: { id: string; kind: EventActorKind };
  agentId: string;
  claimedBy: string | null;
  createdAt: string;
  depth: number;
  /** A dry run reads and thinks, and skips every write. */
  dryRun: boolean;
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
  scopeArtifactId: string | null;
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
  "message.reasoning",
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
  /** `aborted` is accepted for a `running` run (it becomes `interrupted`) and for an `interrupted` one. */
  status: "done" | "failed" | "aborted";
  /** Set when a safeguard ended the run, so the platform records the matching event. */
  stop?: RunStop;
  text?: string;
  usage?: Usage;
}

/** What a machine's daemon gets for the run it just claimed (contract C4). */
export interface MachineClaim {
  agent: {
    id: string;
    model: string;
    name: string;
    runtimeConfig: Record<string, unknown>;
    slug: string;
  };
  /** Ask keys supplied when the daemon supports requests. */
  currentApprovals?: true;
  /** Secrets for the agent's process: its `env` secrets, and the relay token when it has `proxy` ones. Absent when it has none. */
  env?: Record<string, string>;
  inputFileIds: string[];
  instructions: string;
  /** The library folders to copy into the work directory, and the conflict copies waiting in them. */
  library?: {
    conflicts: string[];
    paths: string[];
    roots?: import("@repo/db/shared").LibraryAccessGrant[];
    /** The library path of the run's own folder. Sent with `roots`, to a daemon that syncs the library live. */
    taskFolder?: string;
  };
  mcpServers: Record<
    string,
    { headers: Record<string, string>; type: "http"; url: string }
  >;
  run: {
    agentId: string;
    id: string;
    inputText: string;
    sessionId: string;
    workspaceId: string;
  };
  runToken: string;
  session: {
    id: string;
    runtimeMachineId: string | null;
    runtimeRef: string | null;
  };
  toolRules?: string[];
}

/**
 * What the service lends an adapter. Adapters that run in-process (fake,
 * later managed) use these; the machine adapter's daemon reaches the same
 * functions over HTTP.
 */
export interface AdapterDeps {
  claimRun: (
    principal: Principal,
    runId: string,
    options?: { leaseMs?: number }
  ) => Promise<RunRecord>;
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
  /**
   * The platform ended the run itself (the lease reaper, the unclaimed-run
   * sweep), so the runtime never saw it end. Stops whatever still works on the
   * run. Best effort: the caller logs a throw and goes on.
   */
  abandon?: (run: RunRecord) => Promise<void>;
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
  /**
   * When true, the runs service offers the agent's next waiting run as soon
   * as one of its runs ends. Only the cloud runtime sets it, to true.
   */
  offerNextOnEnd?: boolean;
  resume?: (run: RunRecord, request: RequestRecord) => Promise<void>;
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

/** Runs in these states may still read the skills and connectors of their agent. */
export const LIVE_RUN_STATUSES: readonly RunStatus[] = [
  "queued",
  "offered",
  "running",
  "waiting",
];
