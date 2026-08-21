import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * A question an agent asked its humans: a clarification, or a permission
 * request that gates something destructive on a yes/no (docs/plan-ask-user.md).
 *
 * The row is the structure; the *message* is the surface. Asking posts a
 * message authored by the agent with `origin: "question"`, and this row carries
 * what that message cannot say for itself - the options, who may still answer,
 * and what the answer was. `message_id` is the join between the two, which is
 * how the web card and the Slack mirror render one question from two renderers.
 *
 * `agent_questions.workspace_id` is the tenant boundary and carries no foreign
 * key to `workspaces` - this module must not depend on another module's tables,
 * and `agent_id` / `channel_id` / `message_id` are plain text for the same
 * reason. A dangling id resolves to nothing rather than breaking a read.
 */

/** Written to `messages.origin` for the question card message. */
export const QUESTION_ORIGIN = "question";

/** Written to `messages.origin` for the reply that resolves a question. */
export const ANSWER_ORIGIN = "answer";

/**
 * `permission` is a question with fixed Approve/Deny options and sterner
 * rendering. Enforcement is the agent's own protocol - the MCP tool
 * descriptions tell it to wait - not a server-side gate.
 */
export const QUESTION_KINDS = ["question", "permission"] as const;

/**
 * `pending` is the only state anybody may answer from; `expired` is what the
 * expiry sweep writes, and both are terminal. First answer wins, which is a
 * conditional update off this column rather than a lock.
 */
export const QUESTION_STATUSES = ["pending", "answered", "expired"] as const;

/** Which surface the answer came from - a web card or a Slack button. */
export const ANSWER_SURFACES = ["web", "slack"] as const;

export const agentQuestions = sqliteTable(
  "agent_questions",
  {
    /** The agent that asked, and that the answer wakes. */
    agentId: text("agent_id").notNull(),
    /** The chosen option, or free text when the question had no options. */
    answer: text("answer"),
    answeredAt: integer("answered_at", { mode: "timestamp_ms" }),
    /**
     * A *workspace member* id, or `slack:U…` for a Slack answerer. Never a
     * Clerk user id: this column is resolved to a display name for every view,
     * and a Clerk id must not be stored where a view could reach it.
     */
    answeredBy: text("answered_by"),
    answeredVia: text("answered_via", { enum: ANSWER_SURFACES }),
    channelId: text("channel_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /** Null when the question simply waits, which is the default. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    id: text("id").primaryKey(),
    kind: text("kind", { enum: QUESTION_KINDS }).notNull().default("question"),
    /** The question card message this row hangs off. */
    messageId: text("message_id").notNull(),
    /** JSON `string[]`, or null for a free-text answer. */
    options: text("options"),
    prompt: text("prompt").notNull(),
    status: text("status", { enum: QUESTION_STATUSES })
      .notNull()
      .default("pending"),
    workspaceId: text("workspace_id").notNull(),
  },
  (table) => [
    // The workspace's pending list, and the expiry sweep's scan.
    index("agent_questions_workspace_status_idx").on(
      table.workspaceId,
      table.status
    ),
    // The agent rail's badge, and one agent's history.
    index("agent_questions_agent_status_idx").on(table.agentId, table.status),
    // Message hydration: the question behind an `origin: "question"` message.
    index("agent_questions_message_idx").on(table.messageId),
  ]
);

export type AgentQuestion = typeof agentQuestions.$inferSelect;
export type QuestionKind = (typeof QUESTION_KINDS)[number];
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];
export type AnswerSurface = (typeof ANSWER_SURFACES)[number];
