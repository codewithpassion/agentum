import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import {
  A2A_CONNECTION_STATUSES,
  A2A_DEFAULT_HOURLY_LIMIT,
  A2A_DEFAULT_INBOUND_POLICY,
  A2A_DEFAULT_OUTBOUND_POLICY,
  A2A_DEFAULT_TASK_STATE,
  A2A_DEFAULT_TOOL_POLICY,
  A2A_INBOUND_POLICIES,
  A2A_OUTBOUND_POLICIES,
  A2A_OUTBOX_KINDS,
  A2A_PEER_KINDS,
  A2A_TASK_STATES,
  A2A_TOOL_POLICIES,
} from "../shared.ts";
import { agents } from "./agents.ts";
import { runs } from "./runs.ts";
import { sessions } from "./sessions.ts";
import { workspaces } from "./workspaces.ts";

/**
 * The card a published agent serves at its public id. A card row stays after
 * unpublishing, with `unpublished_at` set. Only the owner's reviewed description
 * and skills go in it, never the agent's instructions.
 */
export const a2aAgentCards = sqliteTable(
  "a2a_agent_cards",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // The text the owner reviewed when publishing.
    description: text("description").notNull(),
    id: id(),
    // Wrong pairing codes since the last good one. The lock follows a run of them.
    pairingFailures: integer("pairing_failures").notNull().default(0),
    // Set while the lock is on. Pairing with a code is refused until then.
    pairingLockedUntil: text("pairing_locked_until"),
    // Whether outside clients may ask to pair with this agent by code.
    pairingOpen: integer("pairing_open", { mode: "boolean" })
      .notNull()
      .default(false),
    // Random, and part of the card URL, so it is unguessable and unique.
    publicId: text("public_id").notNull(),
    publishedAt: text("published_at").notNull(),
    // Clerk user id of the person who published.
    publishedBy: text("published_by").notNull(),
    // JSON text.
    skills: text("skills").notNull(),
    unpublishedAt: text("unpublished_at"),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    uniqueIndex("a2a_agent_cards_agent_id_unique").on(t.agentId),
    uniqueIndex("a2a_agent_cards_public_id_unique").on(t.publicId),
  ]
);

/**
 * An outside client that paired with a published agent by code and waits for a
 * person to approve it. Both the code and the token the client chose are kept
 * as SHA-256 hashes, so neither can be read back.
 */
export const a2aPairingRequests = sqliteTable(
  "a2a_pairing_requests",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    createdAt: createdAt(),
    expiresAt: text("expires_at").notNull(),
    id: id(),
    tokenHash: text("token_hash").notNull(),
    // The start of the token, so requests can be told apart in a list.
    tokenPrefix: text("token_prefix").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    uniqueIndex("a2a_pairing_requests_agent_token_unique").on(
      t.agentId,
      t.tokenHash
    ),
  ]
);

/**
 * One agent's link to one peer. A revoked connection stays, so the log can
 * still name it. Tokens are stored as SHA-256 hashes. The outbound credential
 * is encrypted with the secrets key, so the column holds ciphertext.
 */
export const a2aConnections = sqliteTable(
  "a2a_connections",
  {
    approvedAt: text("approved_at"),
    // Clerk user id of the person who approved the connection.
    approvedBy: text("approved_by"),
    checkCode: text("check_code"),
    createdAt: createdAt(),
    createdBy: text("created_by").notNull(),
    hourlyLimit: integer("hourly_limit")
      .notNull()
      .default(A2A_DEFAULT_HOURLY_LIMIT),
    id: id(),
    inboundPolicy: text("inbound_policy", { enum: A2A_INBOUND_POLICIES })
      .notNull()
      .default(A2A_DEFAULT_INBOUND_POLICY),
    // SHA-256 of the token the peer sends us. Never the token.
    inboundTokenHash: text("inbound_token_hash"),
    // The start of the token, so connections can be told apart in a list.
    inboundTokenPrefix: text("inbound_token_prefix"),
    inviteExpiresAt: text("invite_expires_at"),
    // Wrong tries on the invite. It dies after 5.
    inviteFailures: integer("invite_failures").notNull().default(0),
    // SHA-256 of the invite token. Never the token.
    inviteTokenHash: text("invite_token_hash"),
    lastInAt: text("last_in_at"),
    lastOutAt: text("last_out_at"),
    localAgentId: text("local_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    // The credential we present to the peer. Encrypted, so the column holds
    // ciphertext.
    outboundCredential: text("outbound_credential"),
    outboundPolicy: text("outbound_policy", { enum: A2A_OUTBOUND_POLICIES })
      .notNull()
      .default(A2A_DEFAULT_OUTBOUND_POLICY),
    outboundScheme: text("outbound_scheme"),
    // JSON text.
    peerCard: text("peer_card"),
    peerCardFetchedAt: text("peer_card_fetched_at"),
    peerCardUrl: text("peer_card_url"),
    peerKind: text("peer_kind", { enum: A2A_PEER_KINDS }).notNull(),
    peerLabel: text("peer_label"),
    peerOrg: text("peer_org"),
    peerOrigin: text("peer_origin"),
    revokedAt: text("revoked_at"),
    revokedBy: text("revoked_by"),
    slug: text("slug").notNull(),
    status: text("status", { enum: A2A_CONNECTION_STATUSES }).notNull(),
    toolPolicy: text("tool_policy", { enum: A2A_TOOL_POLICIES })
      .notNull()
      .default(A2A_DEFAULT_TOOL_POLICY),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    uniqueIndex("a2a_connections_inbound_token_unique").on(t.inboundTokenHash),
    uniqueIndex("a2a_connections_invite_token_unique").on(t.inviteTokenHash),
    uniqueIndex("a2a_connections_slug_unique").on(t.workspaceId, t.slug),
  ]
);

/**
 * A task a peer sent us. The row is the server side of the A2A task. It links
 * to a run once one starts. A repeated `message_id` on the same connection
 * returns the first task.
 */
export const a2aTasks = sqliteTable(
  "a2a_tasks",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => a2aConnections.id, { onDelete: "cascade" }),
    // The A2A context. It maps to a session as `<connectionId>:<contextId>`.
    contextId: text("context_id").notNull(),
    createdAt: createdAt(),
    decidedAt: text("decided_at"),
    // Clerk user id of the person who approved or declined the task.
    decidedBy: text("decided_by"),
    hops: integer("hops").notNull().default(0),
    id: id(),
    inputText: text("input_text").notNull(),
    // The message id the peer chose. Unique per connection.
    messageId: text("message_id").notNull(),
    resultText: text("result_text"),
    runId: text("run_id").references(() => runs.id),
    state: text("state", { enum: A2A_TASK_STATES })
      .notNull()
      .default(A2A_DEFAULT_TASK_STATE),
    statusText: text("status_text"),
    updatedAt: text("updated_at").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [
    uniqueIndex("a2a_tasks_connection_message_unique").on(
      t.connectionId,
      t.messageId
    ),
  ]
);

/**
 * Where to push a task's updates. `authentication` and `token` are encrypted,
 * so the columns hold ciphertext.
 */
export const a2aPushConfigs = sqliteTable("a2a_push_configs", {
  // Encrypted.
  authentication: text("authentication"),
  createdAt: createdAt(),
  id: id(),
  taskId: text("task_id")
    .notNull()
    .references(() => a2aTasks.id, { onDelete: "cascade" }),
  // Encrypted.
  token: text("token"),
  url: text("url").notNull(),
  workspaceId: workspaceId().references(() => workspaces.id, {
    onDelete: "cascade",
  }),
});

/**
 * A task our agent sent to a peer. The row is the client side of the A2A task.
 * `request_id` is plain text on purpose: it names a run request, and a run
 * request has no foreign key here.
 */
export const a2aOutboundTasks = sqliteTable(
  "a2a_outbound_tasks",
  {
    callingRunId: text("calling_run_id")
      .notNull()
      .references(() => runs.id),
    connectionId: text("connection_id")
      .notNull()
      .references(() => a2aConnections.id, { onDelete: "cascade" }),
    // The A2A context the peer answered in.
    contextId: text("context_id"),
    createdAt: createdAt(),
    id: id(),
    // When the next `GetTask` poll is due. Null when we are not polling.
    nextPollAt: text("next_poll_at"),
    // When polling stops, at the latest.
    pollUntil: text("poll_until"),
    // The task id the peer assigned.
    remoteTaskId: text("remote_task_id"),
    requestId: text("request_id"),
    resultReadAt: text("result_read_at"),
    resultText: text("result_text"),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    state: text("state", { enum: A2A_TASK_STATES })
      .notNull()
      .default(A2A_DEFAULT_TASK_STATE),
    // The message we sent.
    text: text("text").notNull(),
    updatedAt: text("updated_at").notNull(),
    // Hash of the push webhook token. Never the token.
    webhookTokenHash: text("webhook_token_hash"),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [index("a2a_outbound_tasks_next_poll_idx").on(t.nextPollAt)]
);

/**
 * Deliveries we still owe a peer. The outbox retries with backoff, and a row
 * is dropped with an event after its last attempt. `headers` is encrypted, so
 * the column holds ciphertext.
 */
export const a2aOutbox = sqliteTable(
  "a2a_outbox",
  {
    attempts: integer("attempts").notNull().default(0),
    // JSON text.
    body: text("body").notNull(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => a2aConnections.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    // Encrypted.
    headers: text("headers"),
    id: id(),
    kind: text("kind", { enum: A2A_OUTBOX_KINDS }).notNull(),
    nextAttemptAt: text("next_attempt_at").notNull(),
    url: text("url").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id, {
      onDelete: "cascade",
    }),
  },
  (t) => [index("a2a_outbox_next_attempt_idx").on(t.nextAttemptAt)]
);
