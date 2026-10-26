import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createdAt, id, workspaceId } from "../columns.ts";
import { QA_AUTHOR_KINDS, QA_STATUSES } from "../shared.ts";
import { runs } from "./runs.ts";
import { workspaces } from "./workspaces.ts";

/**
 * A question on the Q&A board, from a person or an agent's run. `run_id` is set
 * on an agent's question and comes from the trusted run context.
 * `accepted_answer_id` has no foreign key: one would make a cycle with
 * `qa_answers.question_id`, and a table in a cycle cannot be rebuilt parents
 * first on D1. The service checks the answer belongs to the question.
 */
export const qaQuestions = sqliteTable(
  "qa_questions",
  {
    acceptedAnswerId: text("accepted_answer_id"),
    // Clerk user id, or the agent id, see `author_kind`.
    authorId: text("author_id").notNull(),
    authorKind: text("author_kind", { enum: QA_AUTHOR_KINDS }).notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
    id: id(),
    runId: text("run_id").references(() => runs.id),
    status: text("status", { enum: QA_STATUSES }).notNull(),
    title: text("title").notNull(),
    updatedAt: text("updated_at").notNull(),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [
    index("qa_questions_status_idx").on(t.workspaceId, t.status, t.createdAt),
  ]
);

/** An answer to a question. Append-only, like inbox posts. */
export const qaAnswers = sqliteTable(
  "qa_answers",
  {
    // Clerk user id, or the agent id, see `author_kind`.
    authorId: text("author_id").notNull(),
    authorKind: text("author_kind", { enum: QA_AUTHOR_KINDS }).notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
    id: id(),
    questionId: text("question_id")
      .notNull()
      .references(() => qaQuestions.id),
    runId: text("run_id").references(() => runs.id),
    workspaceId: workspaceId().references(() => workspaces.id),
  },
  (t) => [index("qa_answers_question_idx").on(t.questionId, t.createdAt)]
);
