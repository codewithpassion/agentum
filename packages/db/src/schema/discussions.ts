import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { DISCUSSION_STATUSES } from "../shared.ts";
import { agents } from "./agents.ts";
import { inboxThreads } from "./inbox.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A lead-run discussion in a team room topic: the lead asks a question, and
 * each round every topic member posts once. The loop guard counts a
 * discussion's wakes against its own budget, rounds times members.
 */
export const discussions = sqliteTable(
  "discussions",
  {
    createdAt: createdAt(),
    id: id(),
    // The round now open, from 1.
    round: integer("round").notNull().default(1),
    // How many rounds the lead asked for, 1 to `DISCUSSION_ROUNDS_MAX`.
    rounds: integer("rounds").notNull(),
    // The lead that started it.
    startedByAgentId: text("started_by_agent_id")
      .notNull()
      .references(() => agents.id),
    status: text("status", { enum: DISCUSSION_STATUSES }).notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => inboxThreads.id, { onDelete: "cascade" }),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("discussions_thread_idx").on(t.threadId, t.status)]
);
