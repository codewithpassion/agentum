import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import {
  MAIL_DIRECTIONS,
  MAIL_MESSAGE_STATUSES,
  MAILBOX_STATUSES,
} from "../shared.ts";
import { agents } from "./agents.ts";
import { runRequests } from "./requests.ts";
import { runs } from "./runs.ts";
import { sessions } from "./sessions.ts";
import { workspaces } from "./workspaces.ts";

/**
 * One mailbox per agent. The address is `<agents.email_local>@<MAIL_DOMAIN>`
 * and is unique across the deployment, because one mail domain serves every
 * workspace. `routing_rule_id` is the Cloudflare Email Routing rule that
 * delivers the address to the Worker. Mail bodies live in the mailbox's
 * Durable Object, never here, and this row id is the Durable Object's name.
 */
export const agentMailboxes = sqliteTable(
  "agent_mailboxes",
  {
    address: text("address").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    createdAt: createdAt(),
    id: id(),
    lastError: text("last_error"),
    routingRuleId: text("routing_rule_id"),
    status: text("status", { enum: MAILBOX_STATUSES }).notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("agent_mailboxes_address_unique").on(t.address),
    uniqueIndex("agent_mailboxes_agent_unique").on(t.agentId),
  ]
);

/**
 * The desk's index of one conversation. `external_thread_id` is the mailbox
 * Durable Object's `emails.thread_id`. `session_id` stays null until the
 * thread's first run starts.
 */
export const mailThreads = sqliteTable(
  "mail_threads",
  {
    externalThreadId: text("external_thread_id").notNull(),
    id: id(),
    lastMessageAt: text("last_message_at").notNull(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => agentMailboxes.id),
    sessionId: text("session_id").references(() => sessions.id),
    subject: text("subject").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("mail_threads_external_unique").on(
      t.mailboxId,
      t.externalThreadId
    ),
    index("mail_threads_workspace_last_idx").on(t.workspaceId, t.lastMessageAt),
    index("mail_threads_session_idx").on(t.sessionId),
  ]
);

/**
 * The index of one message. `external_message_id` is the mailbox Durable
 * Object's `emails.id`, our own uuid, never the RFC `Message-ID` header.
 * `rfc_message_id` holds that header for an outbound row, so a bounce that
 * names the original can find it. `from_address`, `to_addresses` and
 * `cc_addresses` are JSON text (the last two arrays of addresses). `snippet`
 * is the first part of the body for lists. `request_id` is the approval that
 * holds an outside send, and `run_id` is the run the message started (`in`) or
 * the run that wrote it (`out`).
 */
export const mailMessages = sqliteTable(
  "mail_messages",
  {
    ccAddresses: text("cc_addresses").notNull(),
    createdAt: createdAt(),
    direction: text("direction", { enum: MAIL_DIRECTIONS }).notNull(),
    externalMessageId: text("external_message_id").notNull(),
    fromAddress: text("from_address").notNull(),
    id: id(),
    // Why a `failed` message never left, in the sender's words. Null otherwise.
    lastError: text("last_error"),
    requestId: text("request_id").references(() => runRequests.id),
    rfcMessageId: text("rfc_message_id"),
    runId: text("run_id").references(() => runs.id),
    snippet: text("snippet").notNull(),
    status: text("status", { enum: MAIL_MESSAGE_STATUSES }).notNull(),
    subject: text("subject").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => mailThreads.id),
    toAddresses: text("to_addresses").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("mail_messages_external_unique").on(
      t.threadId,
      t.externalMessageId
    ),
    index("mail_messages_thread_created_idx").on(t.threadId, t.createdAt),
    index("mail_messages_rfc_idx").on(t.workspaceId, t.rfcMessageId),
    index("mail_messages_run_idx").on(t.runId),
    index("mail_messages_request_idx").on(t.requestId),
  ]
);
