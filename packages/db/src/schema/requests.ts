import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { ANSWER_SURFACES, REQUEST_KINDS, REQUEST_STATUSES } from "../shared.ts";
import { agents } from "./agents.ts";
import { runs } from "./runs.ts";
import { sessions } from "./sessions.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A run stopped for a person: a tool approval or a question. `(run_id,
 * tool_use_id)` is unique, so a runtime that retries its create gets the same
 * row back. JSON columns hold a zod-validated shape from `@repo/protocol/requests`.
 */
export const runRequests = sqliteTable(
  "run_requests",
  {
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    // JSON, null until answered.
    answer: text("answer"),
    answeredAt: text("answered_at"),
    // Clerk user id.
    answeredBy: text("answered_by"),
    answeredVia: text("answered_via", { enum: ANSWER_SURFACES }),
    createdAt: createdAt(),
    // Set when a managed answer was sent to the runtime.
    deliveredAt: text("delivered_at"),
    // JSON: the scrubbed input summary of an approval, the questions of a question.
    display: text("display").notNull(),
    expiresAt: text("expires_at").notNull(),
    id: id(),
    kind: text("kind", { enum: REQUEST_KINDS }).notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    // JSON `{ appId, channel, ts }`, null when no card was posted.
    slackMessage: text("slack_message"),
    status: text("status", { enum: REQUEST_STATUSES }).notNull(),
    // Null for a question.
    toolKey: text("tool_key"),
    // The runtime's name for the tool.
    toolName: text("tool_name").notNull(),
    // The runtime's call id.
    toolUseId: text("tool_use_id").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    uniqueIndex("run_requests_tool_use_unique").on(t.runId, t.toolUseId),
    index("run_requests_workspace_status_idx").on(t.workspaceId, t.status),
    index("run_requests_status_expires_idx").on(t.status, t.expiresAt),
  ]
);
