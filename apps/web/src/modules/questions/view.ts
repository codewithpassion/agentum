import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { resolveSlackUserNames } from "#/modules/bridges/slack/users";
import { resolveMembersByIds } from "#/modules/workspaces/authors";
import { type AgentQuestion, agentQuestions } from "./schema";

/**
 * Questions as a client may see them, and the lookup that hangs one off its
 * message.
 *
 * This file exists apart from `service.ts` for the same reason
 * `workspaces/authors.ts` does: `service.ts` reaches into messaging to post the
 * question and its answer, so messaging cannot import it back. Nothing in here
 * touches another module's tables - member and Slack names are resolved through
 * those modules' own public helpers - which is what lets `hydrateMessages` call
 * it without closing a cycle.
 */

/** Who answered, as a name a client may render. Never a Clerk user id. */
export interface QuestionAnswererView {
  /** The workspace member id, or `slack:U…` for a Slack answerer. */
  id: string;
  name: string;
}

export interface QuestionView {
  agentId: string;
  /** The chosen option or free text; null until answered. */
  answer: string | null;
  answeredAt: number | null;
  answeredBy: QuestionAnswererView | null;
  answeredVia: "slack" | "web" | null;
  channelId: string;
  createdAt: number;
  expiresAt: number | null;
  id: string;
  kind: "permission" | "question";
  /** The question card message; the answer reply hangs under it as a thread. */
  messageId: string;
  /** The buttons to render; null means the answer is free text. */
  options: string[] | null;
  prompt: string;
  status: "answered" | "expired" | "pending";
}

const SLACK_PREFIX = "slack:";

/** Stored JSON to a string array, tolerating a row written before validation. */
export const optionsOf = (question: AgentQuestion): string[] | null => {
  if (question.options === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(question.options);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const options = parsed.filter(
    (item): item is string => typeof item === "string"
  );
  return options.length > 0 ? options : null;
};

export const toQuestionView = (
  question: AgentQuestion,
  answeredBy: QuestionAnswererView | null = null
): QuestionView => ({
  agentId: question.agentId,
  answer: question.answer,
  answeredAt: question.answeredAt?.getTime() ?? null,
  answeredBy,
  answeredVia: question.answeredVia,
  channelId: question.channelId,
  createdAt: question.createdAt.getTime(),
  expiresAt: question.expiresAt?.getTime() ?? null,
  id: question.id,
  kind: question.kind,
  messageId: question.messageId,
  options: optionsOf(question),
  prompt: question.prompt,
  status: question.status,
});

/**
 * Display names for the `answered_by` column of a batch of rows: workspace
 * members through their membership, Slack users through the name cache the
 * bridge already keeps (cache only - a view must not spend a Slack round trip).
 */
export const resolveAnswerers = async (
  db: Db,
  workspaceId: string,
  questions: readonly AgentQuestion[]
): Promise<Map<string, QuestionAnswererView>> => {
  const ids = [
    ...new Set(
      questions.flatMap((question) =>
        question.answeredBy ? [question.answeredBy] : []
      )
    ),
  ];
  const resolved = new Map<string, QuestionAnswererView>();
  if (ids.length === 0) {
    return resolved;
  }

  const slackIds = ids
    .filter((id) => id.startsWith(SLACK_PREFIX))
    .map((id) => id.slice(SLACK_PREFIX.length));
  const memberIds = ids.filter((id) => !id.startsWith(SLACK_PREFIX));

  const [members, slackNames] = await Promise.all([
    resolveMembersByIds(db, workspaceId, memberIds),
    resolveSlackUserNames(db, null, slackIds),
  ]);

  for (const id of ids) {
    if (id.startsWith(SLACK_PREFIX)) {
      const slackId = id.slice(SLACK_PREFIX.length);
      resolved.set(id, { id, name: slackNames.get(slackId) ?? slackId });
      continue;
    }
    resolved.set(id, { id, name: members.get(id)?.name ?? id });
  }
  return resolved;
};

export const toQuestionViews = async (
  db: Db,
  workspaceId: string,
  questions: readonly AgentQuestion[]
): Promise<QuestionView[]> => {
  const answerers = await resolveAnswerers(db, workspaceId, questions);
  return questions.map((question) =>
    toQuestionView(
      question,
      question.answeredBy ? (answerers.get(question.answeredBy) ?? null) : null
    )
  );
};

/**
 * The questions behind a batch of message ids, for message hydration. Called
 * only when a message with `origin: "question"` is in the batch, so the common
 * read costs nothing.
 */
export const questionsForMessages = async (
  db: Db,
  workspaceId: string,
  messageIds: readonly string[]
): Promise<Map<string, QuestionView>> => {
  const byMessage = new Map<string, QuestionView>();
  if (messageIds.length === 0) {
    return byMessage;
  }
  const rows = await db
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.workspaceId, workspaceId),
        inArray(agentQuestions.messageId, [...messageIds])
      )
    );

  for (const view of await toQuestionViews(db, workspaceId, rows)) {
    byMessage.set(view.messageId, view);
  }
  return byMessage;
};
