/** A workspace's shared question board. Authors come only from trusted principals. */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { qaAnswers, qaQuestions } from "@repo/db/schema/qa";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import {
  QA_BODY_MAX,
  QA_OPEN_PER_AGENT_MAX,
  QA_STATUSES,
  QA_TITLE_MAX,
} from "@repo/db/shared";
import { and, asc, count, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { monotonicFactory } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { isServiceError, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import { checkWakeRate, WAKE_LIMIT_WINDOW_MS } from "./inbox/loop-guard.ts";
import type { Clock } from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import type { Principal } from "./workspaces.ts";

const nextId = monotonicFactory();
export const QA_LIST_LIMIT = 50;
const idString = z.string().min(1).max(200);
const bodySchema = z.string().trim().min(1).max(QA_BODY_MAX);
export const askInputSchema = z.strictObject({
  body: bodySchema,
  title: z.string().trim().min(1).max(QA_TITLE_MAX),
});
export const answerInputSchema = z.strictObject({
  body: bodySchema,
  questionId: idString,
});
export const questionInputSchema = z.strictObject({ questionId: idString });
export const acceptInputSchema = z.strictObject({
  answerId: idString,
  questionId: idString,
});
export const listInputSchema = z.strictObject({
  author: idString.optional(),
  cursor: idString.optional(),
  status: z.enum(QA_STATUSES).optional(),
});

type Member = Extract<Principal, { kind: "user" | "run" }>;
export type QuestionRecord = typeof qaQuestions.$inferSelect;
export type AnswerRecord = typeof qaAnswers.$inferSelect;

/** As in skills-store's memberOf: run authors are agents, read-only keys only read. */
const memberOf = (
  principal: Principal,
  action: string,
  write: boolean
): Member => {
  if (principal.kind !== "user" && principal.kind !== "run") {
    throw new ForbiddenError(action);
  }
  authorize(principal, action, {
    kind: "qa",
    workspaceId: principal.workspaceId,
  });
  if (
    write &&
    principal.kind === "user" &&
    (principal.apiKey?.access === "read" ||
      principal.oauthClient?.access === "read")
  ) {
    throw new ForbiddenError(action);
  }
  return principal;
};
const authorOf = (member: Member) => ({
  authorId: member.kind === "run" ? member.agentId : member.userId,
  authorKind: member.kind === "run" ? ("agent" as const) : ("user" as const),
  runId: member.kind === "run" ? member.runId : null,
});
const eventOrigin = (member: Member) => {
  const author = authorOf(member);
  return {
    actor: { id: author.authorId, kind: author.authorKind },
    agentId: member.kind === "run" ? member.agentId : null,
    runId: author.runId,
    workspaceId: member.workspaceId,
  };
};

export interface QaServiceOptions {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  runs: Pick<RunsService, "startRun">;
}

export const createQaService = ({
  atomic,
  clock,
  db,
  events,
  runs,
}: QaServiceOptions) => {
  const requireQuestion = async (
    member: Member,
    id: string
  ): Promise<QuestionRecord> => {
    const [question] = await db
      .select()
      .from(qaQuestions)
      .where(
        and(
          eq(qaQuestions.workspaceId, member.workspaceId),
          eq(qaQuestions.id, id)
        )
      );
    if (!question) {
      throw new ServiceError("not_found", "Question not found");
    }
    return question;
  };
  // Board moderation is for workspace people and the agent that asked the question.
  // The spec does not restrict people to their own questions, matching inbox's shared board.
  const requireModerator = (member: Member, question: QuestionRecord) => {
    if (
      member.kind === "run" &&
      (question.authorKind !== "agent" || member.agentId !== question.authorId)
    ) {
      throw new ForbiddenError("qa.moderate");
    }
  };
  const ask = async (
    principal: Principal,
    rawInput: z.input<typeof askInputSchema>
  ): Promise<QuestionRecord> => {
    const member = memberOf(principal, "qa.ask", true);
    const input = askInputSchema.parse(rawInput);
    const now = clock.now();
    const author = authorOf(member);
    // INSERT ... SELECT enforces the cap in the write itself, even for concurrent asks.
    // Only accepted questions become answered; an unaccepted answer keeps a question open.
    const [question] = await db
      .insert(qaQuestions)
      .select(
        db
          .select({
            acceptedAnswerId: sql<string | null>`null`.as("accepted_answer_id"),
            authorId: sql<string>`${author.authorId}`.as("author_id"),
            authorKind: sql<typeof author.authorKind>`${author.authorKind}`.as(
              "author_kind"
            ),
            body: sql<string>`${input.body}`.as("body"),
            createdAt: sql<string>`${now.toISOString()}`.as("created_at"),
            id: sql<string>`${nextId(now.getTime())}`.as("id"),
            runId: sql<string | null>`${author.runId}`.as("run_id"),
            status: sql<"open">`'open'`.as("status"),
            title: sql<string>`${input.title}`.as("title"),
            updatedAt: sql<string>`${now.toISOString()}`.as("updated_at"),
            workspaceId: sql<string>`${member.workspaceId}`.as("workspace_id"),
          })
          .from(sql`(select 1)`)
          .where(
            member.kind === "run"
              ? sql`(select count(*) from ${qaQuestions} where ${qaQuestions.workspaceId} = ${member.workspaceId} and ${qaQuestions.status} = 'open' and ${qaQuestions.authorId} = ${author.authorId}) < ${QA_OPEN_PER_AGENT_MAX}`
              : sql`1`
          )
      )
      .returning();
    if (!question) {
      throw new ServiceError("conflict", "Agent open-question limit reached");
    }
    await events.append({
      ...eventOrigin(member),
      payload: { questionId: question.id },
      type: "qa.asked",
    });
    return question;
  };

  const recordStop = (
    member: Member,
    question: QuestionRecord,
    answerId: string,
    reason: "budget" | "refused",
    message?: string
  ) =>
    // There is no qa wake-stop type: reuse the existing wake diagnostic event.
    events.append({
      ...eventOrigin(member),
      agentId: question.authorId,
      payload: {
        answerId,
        questionId: question.id,
        reason,
        ...(message === undefined ? {} : { message }),
      },
      type: "inbox.loop_stopped",
    });

  const wake = async (
    member: Member,
    question: QuestionRecord,
    entry: AnswerRecord
  ) => {
    if (
      question.authorKind !== "agent" ||
      (entry.authorKind === "agent" && entry.authorId === question.authorId)
    ) {
      return;
    }
    const now = clock.now().getTime();
    // Count inbox and qa wakes together: changing surfaces must not bypass the agent budget.
    const recent = await db
      .select({ createdAt: runRows.createdAt })
      .from(runRows)
      .innerJoin(sessions, eq(runRows.sessionId, sessions.id))
      .where(
        and(
          eq(runRows.workspaceId, member.workspaceId),
          eq(runRows.agentId, question.authorId),
          inArray(sessions.origin, ["inbox", "qa"]),
          gt(
            runRows.createdAt,
            new Date(now - WAKE_LIMIT_WINDOW_MS).toISOString()
          )
        )
      );
    if (
      !checkWakeRate(
        recent.map((row) => Date.parse(row.createdAt)),
        now
      ).allowed
    ) {
      await recordStop(member, question, entry.id, "budget");
      return;
    }
    try {
      await runs.startRun(member, {
        agentId: question.authorId,
        input: {
          text: `Answer to Q&A question ${question.id}\n\n${question.title}\n${question.body}\n\nAnswer:\n${entry.body}`,
        },
        reply: { kind: "none" },
        session: { externalKey: `qa:${question.id}`, origin: "qa" },
      });
    } catch (error) {
      if (!isServiceError(error)) {
        throw error;
      }
      await recordStop(member, question, entry.id, "refused", error.message);
    }
  };

  const answer = async (
    principal: Principal,
    rawInput: z.input<typeof answerInputSchema>
  ): Promise<AnswerRecord> => {
    const member = memberOf(principal, "qa.answer", true);
    const input = answerInputSchema.parse(rawInput);
    const question = await requireQuestion(member, input.questionId);
    const now = clock.now();
    const row: AnswerRecord = {
      ...authorOf(member),
      body: input.body,
      createdAt: now.toISOString(),
      id: nextId(now.getTime()),
      questionId: question.id,
      workspaceId: member.workspaceId,
    };
    const writable = and(
      eq(qaQuestions.id, question.id),
      eq(qaQuestions.workspaceId, member.workspaceId),
      sql`${qaQuestions.status} != 'closed'`
    );
    await atomic([
      db.insert(qaAnswers).select(
        db
          .select({
            authorId: sql<string>`${row.authorId}`.as("author_id"),
            authorKind: sql<typeof row.authorKind>`${row.authorKind}`.as(
              "author_kind"
            ),
            body: sql<string>`${row.body}`.as("body"),
            createdAt: sql<string>`${row.createdAt}`.as("created_at"),
            id: sql<string>`${row.id}`.as("id"),
            questionId: sql<string>`${row.questionId}`.as("question_id"),
            runId: sql<string | null>`${row.runId}`.as("run_id"),
            workspaceId: sql<string>`${row.workspaceId}`.as("workspace_id"),
          })
          .from(sql`(select 1)`)
          .where(sql`exists (select 1 from ${qaQuestions} where ${writable})`)
      ),
      db
        .update(qaQuestions)
        .set({ updatedAt: row.createdAt })
        .where(
          and(
            writable,
            sql`exists (select 1 from ${qaAnswers} where ${qaAnswers.id} = ${row.id})`
          )
        ),
    ]);
    const [written] = await db
      .select()
      .from(qaAnswers)
      .where(
        and(
          eq(qaAnswers.id, row.id),
          eq(qaAnswers.workspaceId, member.workspaceId)
        )
      );
    if (!written) {
      throw new ServiceError("conflict", "Question is closed");
    }
    await events.append({
      ...eventOrigin(member),
      payload: { answerId: row.id, questionId: question.id },
      type: "qa.answered",
    });
    await wake(member, question, written);
    return written;
  };

  const accept = async (
    principal: Principal,
    rawInput: z.input<typeof acceptInputSchema>
  ): Promise<QuestionRecord> => {
    const member = memberOf(principal, "qa.accept", true);
    const input = acceptInputSchema.parse(rawInput);
    const question = await requireQuestion(member, input.questionId);
    requireModerator(member, question);
    const [answerRow] = await db
      .select({ id: qaAnswers.id })
      .from(qaAnswers)
      .where(
        and(
          eq(qaAnswers.workspaceId, member.workspaceId),
          eq(qaAnswers.questionId, question.id),
          eq(qaAnswers.id, input.answerId)
        )
      );
    if (!answerRow) {
      throw new ServiceError("not_found", "Answer not found");
    }
    const [updated] = await db
      .update(qaQuestions)
      .set({
        acceptedAnswerId: answerRow.id,
        status: "answered",
        updatedAt: clock.now().toISOString(),
      })
      .where(
        and(
          eq(qaQuestions.workspaceId, member.workspaceId),
          eq(qaQuestions.id, question.id),
          sql`${qaQuestions.status} != 'closed'`
        )
      )
      .returning();
    if (!updated) {
      throw new ServiceError("conflict", "Question is closed");
    }
    await events.append({
      ...eventOrigin(member),
      payload: { answerId: answerRow.id, questionId: question.id },
      type: "qa.accepted",
    });
    return updated;
  };

  const close = async (
    principal: Principal,
    rawInput: z.input<typeof questionInputSchema>
  ): Promise<QuestionRecord> => {
    const member = memberOf(principal, "qa.close", true);
    const input = questionInputSchema.parse(rawInput);
    const question = await requireQuestion(member, input.questionId);
    requireModerator(member, question);
    // Close is idempotent; only the actual transition emits qa.closed.
    const [updated] = await db
      .update(qaQuestions)
      .set({ status: "closed", updatedAt: clock.now().toISOString() })
      .where(
        and(
          eq(qaQuestions.workspaceId, member.workspaceId),
          eq(qaQuestions.id, question.id),
          sql`${qaQuestions.status} != 'closed'`
        )
      )
      .returning();
    if (!updated) {
      return requireQuestion(member, question.id);
    }
    await events.append({
      ...eventOrigin(member),
      payload: { questionId: question.id },
      type: "qa.closed",
    });
    return updated;
  };

  const get = async (principal: Principal, rawId: string) => {
    const member = memberOf(principal, "qa.read", false);
    const question = await requireQuestion(member, idString.parse(rawId));
    const answers = await db
      .select()
      .from(qaAnswers)
      .where(
        and(
          eq(qaAnswers.workspaceId, member.workspaceId),
          eq(qaAnswers.questionId, question.id)
        )
      )
      .orderBy(asc(qaAnswers.id));
    return { answers, question };
  };
  const list = async (
    principal: Principal,
    rawInput: z.input<typeof listInputSchema> = {}
  ) => {
    const member = memberOf(principal, "qa.read", false);
    const input = listInputSchema.parse(rawInput);
    // Monotonic ids provide an exclusive newest-first cursor even for tied timestamps.
    const rows = await db
      .select()
      .from(qaQuestions)
      .where(
        and(
          eq(qaQuestions.workspaceId, member.workspaceId),
          input.status ? eq(qaQuestions.status, input.status) : undefined,
          input.author ? eq(qaQuestions.authorId, input.author) : undefined,
          input.cursor ? lt(qaQuestions.id, input.cursor) : undefined
        )
      )
      .orderBy(desc(qaQuestions.id))
      .limit(QA_LIST_LIMIT + 1);
    const questions = rows.slice(0, QA_LIST_LIMIT);
    return {
      nextCursor:
        rows.length > QA_LIST_LIMIT ? (questions.at(-1)?.id ?? null) : null,
      questions,
    };
  };
  const openCount = async (principal: Principal): Promise<number> => {
    const member = memberOf(principal, "qa.read", false);
    // The nav badge counts the shared board's open questions, across all authors.
    const [row] = await db
      .select({ total: count() })
      .from(qaQuestions)
      .where(
        and(
          eq(qaQuestions.workspaceId, member.workspaceId),
          eq(qaQuestions.status, "open")
        )
      );
    return row?.total ?? 0;
  };
  return { accept, answer, ask, close, get, list, openCount };
};
export type QaService = ReturnType<typeof createQaService>;
