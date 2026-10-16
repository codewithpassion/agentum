import { z } from "zod";

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
  inputFileIds: z.array(z.string()),
  instructions: z.string(),
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
  z.strictObject({ status: z.literal("failed"), ...completeOutcomeFields }),
  z.strictObject({ status: z.literal("aborted") }),
]);
export type CompleteRequest = z.infer<typeof completeRequestSchema>;

export const completeResponseSchema = z.strictObject({});
export type CompleteResponse = z.infer<typeof completeResponseSchema>;
