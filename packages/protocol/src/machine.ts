import { REQUEST_KINDS, REQUEST_STATUSES } from "@repo/db/shared";
import { z } from "zod";
import {
  approvalDisplaySchema,
  questionDisplaySchema,
  requestOutcomeSchema,
} from "./requests.ts";
import { runStopSchema } from "./safeguards.ts";

/**
 * The header a daemon sends with its claim to list the optional features it
 * understands, comma separated. The Worker adds a feature's data to the claim
 * only for a daemon that names it, because the claim schema is strict and an
 * older daemon rejects a key it does not know.
 */
export const DAEMON_FEATURES_HEADER = "X-Daemon-Features";

/** The daemon copies the claim's `library` folders to disk and syncs them (W.8). */
export const FEATURE_LIBRARY_SYNC = "library-sync";

/** The daemon can raise approval and question requests and wait for them (V1.9). */
export const FEATURE_REQUESTS = "requests";

/** Whether the value of `DAEMON_FEATURES_HEADER` names `feature`. */
export const hasDaemonFeature = (
  header: string | null | undefined,
  feature: string
): boolean =>
  (header ?? "")
    .split(",")
    .map((name) => name.trim())
    .includes(feature);

export const LEASE_SECONDS = 90;
export const HEARTBEAT_SECONDS = 20;
export const CLOSE_CODES = {
  credentialRejected: 4401,
  replaced: 1012,
} as const;

const isoTimestampSchema = z.iso.datetime({ offset: true });
const jsonRecordSchema = z.record(z.string(), z.json());

export const enrollRequestSchema = z.strictObject({
  code: z.string().startsWith("hm_enr_").max(200),
  singleUser: z.boolean(),
});
export type EnrollRequest = z.infer<typeof enrollRequestSchema>;

export const enrollResponseSchema = z.strictObject({
  credential: z.string().startsWith("hm_mach_"),
  machineId: z.string(),
});
export type EnrollResponse = z.infer<typeof enrollResponseSchema>;

export const daemonHelloSchema = z.strictObject({
  // Agent ULIDs, the same ids as `offer.agentId` and `claim.agent.id`, for the
  // agents the daemon has a working directory for. Informational: the relay
  // offers runs by the agents assigned to the machine in D1, never by this list.
  agents: z.array(z.string()),
  capabilities: z.strictObject({
    agentSdk: z.string(),
    container: z.boolean(),
  }),
  daemonVersion: z.string(),
  type: z.literal("hello"),
});
export type DaemonHello = z.infer<typeof daemonHelloSchema>;

export const daemonPingSchema = z.strictObject({
  at: isoTimestampSchema,
  type: z.literal("ping"),
});
export type DaemonPing = z.infer<typeof daemonPingSchema>;

export const daemonFrameSchema = z.discriminatedUnion("type", [
  daemonHelloSchema,
  daemonPingSchema,
]);
export type DaemonFrame = z.infer<typeof daemonFrameSchema>;

export const relayHelloAckSchema = z.strictObject({
  machineId: z.string(),
  serverTime: isoTimestampSchema,
  type: z.literal("hello_ack"),
});
export type RelayHelloAck = z.infer<typeof relayHelloAckSchema>;

export const offerSchema = z.strictObject({
  agentId: z.string(),
  runId: z.string(),
  type: z.literal("offer"),
});
export type Offer = z.infer<typeof offerSchema>;

export const cancelSchema = z.strictObject({
  runId: z.string(),
  type: z.literal("cancel"),
});
export type Cancel = z.infer<typeof cancelSchema>;

export const relayFrameSchema = z.discriminatedUnion("type", [
  relayHelloAckSchema,
  offerSchema,
  cancelSchema,
]);
export type RelayFrame = z.infer<typeof relayFrameSchema>;

export const claimResponseSchema = z.strictObject({
  agent: z.strictObject({
    id: z.string(),
    model: z.string(),
    name: z.string(),
    runtimeConfig: jsonRecordSchema,
    slug: z.string(),
  }),
  // Secrets the agent is granted as environment variables. Absent when there
  // are none, so a daemon that predates them still parses the claim.
  env: z.record(z.string(), z.string()).optional(),
  inputFileIds: z.array(z.string()),
  instructions: z.string(),
  // The library folders the daemon copies into the work directory, and the
  // conflict copies waiting in them. Optional, so a Worker that predates the
  // library sync still parses on a newer daemon.
  library: z
    .strictObject({
      conflicts: z.array(z.string()),
      paths: z.array(z.string()),
    })
    .optional(),
  mcpServers: z.record(
    z.string(),
    z.strictObject({
      headers: z.record(z.string(), z.string()),
      type: z.literal("http"),
      url: z.string(),
    })
  ),
  run: z.strictObject({
    agentId: z.string(),
    id: z.string(),
    inputText: z.string(),
    sessionId: z.string(),
    // The daemon lays out its work directories by workspace and agent.
    workspaceId: z.string(),
  }),
  runToken: z.string().startsWith("hm_run_"),
  session: z.strictObject({
    id: z.string(),
    runtimeMachineId: z.string().nullable(),
    runtimeRef: z.string().nullable(),
  }),
  // The agent's ask tool keys, sent only to a daemon that names FEATURE_REQUESTS
  // (the schema is strict, so an older daemon would reject the key).
  toolRules: z.array(z.string()).optional(),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const runEventInputSchema = z.strictObject({
  payload: jsonRecordSchema,
  seq: z.int().min(1),
  type: z.enum(["message.assistant", "tool.call", "tool.result"]),
});
export type RunEventInput = z.infer<typeof runEventInputSchema>;

export const eventsRequestSchema = z.strictObject({
  events: z.array(runEventInputSchema),
});
export type EventsRequest = z.infer<typeof eventsRequestSchema>;

export const eventsResponseSchema = z.strictObject({
  lastSeq: z.int().nonnegative(),
});
export type EventsResponse = z.infer<typeof eventsResponseSchema>;

export const heartbeatResponseSchema = z.strictObject({});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

export const usageSchema = z.strictObject({
  costUsd: z.number().nonnegative().optional(),
  inputTokens: z.int().nonnegative().optional(),
  outputTokens: z.int().nonnegative().optional(),
});
export type Usage = z.infer<typeof usageSchema>;

const completeOutcomeFields = {
  error: z.string().optional(),
  fileIds: z.array(z.string()).optional(),
  runtimeRef: z.string().optional(),
  text: z.string().optional(),
  usage: usageSchema.optional(),
};

export const completeRequestSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("done"), ...completeOutcomeFields }),
  // Deploy the Worker before the daemon: the schema is strict, so an older
  // Worker rejects a `stop` key, and the daemon sends it on a turn-limit stop.
  z.strictObject({
    status: z.literal("failed"),
    ...completeOutcomeFields,
    stop: runStopSchema.optional(),
  }),
  z.strictObject({ status: z.literal("aborted") }),
]);
export type CompleteRequest = z.infer<typeof completeRequestSchema>;

export const completeResponseSchema = z.strictObject({});
export type CompleteResponse = z.infer<typeof completeResponseSchema>;

export const createRequestBodySchema = z.strictObject({
  display: z.union([approvalDisplaySchema, questionDisplaySchema]),
  kind: z.enum(REQUEST_KINDS),
  toolName: z.string(),
  toolUseId: z.string().min(1),
});
export type CreateRequestBody = z.infer<typeof createRequestBodySchema>;

export const createRequestResponseSchema = z.strictObject({
  outcome: requestOutcomeSchema.optional(),
  requestId: z.string(),
  status: z.enum(REQUEST_STATUSES),
});
export type CreateRequestResponse = z.infer<typeof createRequestResponseSchema>;

export const waitRequestResponseSchema = z.strictObject({
  outcome: requestOutcomeSchema.optional(),
  status: z.enum(REQUEST_STATUSES),
});
export type WaitRequestResponse = z.infer<typeof waitRequestResponseSchema>;
