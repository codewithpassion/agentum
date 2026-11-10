import {
  LIBRARY_ACCESS_MODES,
  MACHINE_ROLES,
  REQUEST_KINDS,
  REQUEST_STATUSES,
} from "@repo/db/shared";
import { z } from "zod";
import {
  approvalDisplaySchema,
  questionDisplaySchema,
  requestOutcomeSchema,
} from "./requests.ts";
import { runStopSchema } from "./safeguards.ts";
import {
  ENROLL_CODE,
  MACHINE_CREDENTIAL,
  RUN_TOKEN,
  type TokenPrefix,
} from "./token-prefixes.ts";

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
/** The daemon runs subagent sessions alongside their parent. */
export const FEATURE_PARALLEL_SUBAGENTS = "parallel-subagents";
export const FEATURE_CURRENT_APPROVALS = "current-approvals";

/** The daemon takes `library_changed` relay frames and the claim's library `roots` and `taskFolder` (V4). */
export const FEATURE_LIBRARY_LIVE = "library-live";

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

/** Either prefix of a token kind, at the start. */
const startsWith = (kind: TokenPrefix): RegExp =>
  new RegExp(`^${kind.pattern}`);

const isoTimestampSchema = z.iso.datetime({ offset: true });
const jsonRecordSchema = z.record(z.string(), z.json());

export const enrollRequestSchema = z.strictObject({
  code: z.string().regex(startsWith(ENROLL_CODE)).max(200),
  singleUser: z.boolean(),
});
export type EnrollRequest = z.infer<typeof enrollRequestSchema>;

/**
 * A computer client enrols with a code that adds the `computer` role to a
 * machine. The daemon's body has no `role`, so the two never overlap.
 */
export const computerEnrollRequestSchema = z.strictObject({
  arch: z.string().min(1).max(64),
  clientVersion: z.string().min(1).max(64),
  code: z.string().regex(startsWith(ENROLL_CODE)).max(200),
  hostname: z.string().min(1).max(255),
  os: z.string().min(1).max(64),
  role: z.literal("computer"),
});
export type ComputerEnrollRequest = z.infer<typeof computerEnrollRequestSchema>;

/** The new client sends Go platform names and lets the code choose its roles. */
export const machineRolesSchema = z
  .array(z.enum(MACHINE_ROLES))
  .min(1)
  .max(2)
  .refine((roles) => new Set(roles).size === roles.length, {
    message: "Machine roles must be unique",
  });

export const rolesEnrollRequestSchema = z.strictObject({
  arch: z.enum(["amd64", "arm64"]),
  clientVersion: z.string().min(1).max(64),
  code: z.string().regex(startsWith(ENROLL_CODE)).max(200),
  hostname: z.string().min(1).max(255),
  os: z.literal("linux"),
  roles: machineRolesSchema.optional(),
  singleUser: z.boolean(),
});
export type RolesEnrollRequest = z.infer<typeof rolesEnrollRequestSchema>;

/** What `/api/machines/enroll` parses. */
export const machineEnrollRequestSchema = z.union([
  enrollRequestSchema,
  computerEnrollRequestSchema,
  rolesEnrollRequestSchema,
]);
export type MachineEnrollRequest = z.infer<typeof machineEnrollRequestSchema>;

export const enrollResponseSchema = z.strictObject({
  credential: z.string().regex(startsWith(MACHINE_CREDENTIAL)),
  machineId: z.string(),
});
export type EnrollResponse = z.infer<typeof enrollResponseSchema>;

export const rolesEnrollResponseSchema = enrollResponseSchema.extend({
  machineName: z.string(),
  roles: machineRolesSchema,
});
export type RolesEnrollResponse = z.infer<typeof rolesEnrollResponseSchema>;

/**
 * A check `agentum doctor` failed on, with its own fix in `message`. A client
 * sends the list in its hello and an empty list says the doctor passed.
 */
export const doctorProblemSchema = z.strictObject({
  message: z.string().max(2000),
  name: z.string().min(1).max(100),
});
export const doctorProblemsSchema = z.array(doctorProblemSchema).max(20);
export type DoctorProblem = z.infer<typeof doctorProblemSchema>;

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
  // What `agentum doctor` found. An older client omits it.
  doctor: doctorProblemsSchema.optional(),
  // The daemon's optional features (see DAEMON_FEATURES_HEADER). An old daemon
  // omits it.
  features: z.array(z.string()).optional(),
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
  subagent: z.boolean().optional(),
  type: z.literal("offer"),
});
export type Offer = z.infer<typeof offerSchema>;

export const cancelSchema = z.strictObject({
  runId: z.string(),
  type: z.literal("cancel"),
});
export type Cancel = z.infer<typeof cancelSchema>;

export const libraryChangedSchema = z.strictObject({
  paths: z.array(z.string()),
  type: z.literal("library_changed"),
});
export type LibraryChanged = z.infer<typeof libraryChangedSchema>;

export const relayFrameSchema = z.discriminatedUnion("type", [
  relayHelloAckSchema,
  offerSchema,
  cancelSchema,
  libraryChangedSchema,
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
  // The agent's ask tool keys, sent only to a daemon that names FEATURE_REQUESTS
  // (the schema is strict, so an older daemon would reject the key).
  currentApprovals: z.literal(true).optional(),
  // Secrets the agent is granted as environment variables. Absent when there
  // are none, so a daemon that predates them still parses the claim.
  env: z.record(z.string(), z.string()).optional(),
  inputFileIds: z.array(z.string()),
  instructions: z.string(),
  // The library folders the daemon copies into the work directory, and the
  // conflict copies waiting in them. Optional, so a Worker that predates the
  // library sync still parses on a newer daemon. roots and taskFolder are sent
  // only to a daemon that names FEATURE_LIBRARY_LIVE (the schema is strict, so
  // an older daemon would reject the keys).
  library: z
    .strictObject({
      conflicts: z.array(z.string()),
      paths: z.array(z.string()),
      roots: z
        .array(
          z.strictObject({
            mode: z.enum(LIBRARY_ACCESS_MODES),
            path: z.string(),
          })
        )
        .optional(),
      taskFolder: z.string().optional(),
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
  runToken: z.string().regex(startsWith(RUN_TOKEN)),
  session: z.strictObject({
    id: z.string(),
    runtimeMachineId: z.string().nullable(),
    runtimeRef: z.string().nullable(),
  }),
  toolRules: z.array(z.string()).optional(),
});
export type ClaimResponse = z.infer<typeof claimResponseSchema>;

export const runEventInputSchema = z.strictObject({
  payload: jsonRecordSchema,
  seq: z.int().min(1),
  type: z.enum([
    "message.assistant",
    "message.reasoning",
    "tool.call",
    "tool.result",
  ]),
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
