import { and, asc, desc, eq, isNotNull, lte, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import { getAgentById } from "#/modules/agents/service";
import {
  fanOutMessage,
  fanOutQuestionUpdate,
  publishMessage,
} from "#/modules/messaging/publish";
import {
  addChannelMember,
  createMessage,
  getChannel,
  getMessageView,
  type MessageView,
  type WorkspaceRef,
} from "#/modules/messaging/service";
import {
  type AgentQuestion,
  ANSWER_ORIGIN,
  type AnswerSurface,
  agentQuestions,
  QUESTION_KINDS,
  QUESTION_ORIGIN,
  type QuestionKind,
} from "./schema";
import { optionsOf, type QuestionView, toQuestionViews } from "./view";

/**
 * Asking, answering, and running out of time.
 *
 * A question is two things written in order: a message authored by the agent
 * with `origin: "question"`, then a row pointing at it. Both halves are needed
 * before anybody sees it, which is why `ask` composes `createMessage` and the
 * fan-out by hand instead of calling `publishMessage` - the view that reaches
 * open clients has to already carry the question.
 *
 * Answering is a conditional `UPDATE … WHERE status = 'pending'`. That single
 * statement is the whole concurrency story: two people clicking at once, a
 * Slack button racing a web card, an expiry sweep racing an answer - exactly
 * one of them gets the row back, and only that one posts the reply and wakes
 * the agent. Everybody else is told who won.
 */

export const PROMPT_MAX_LENGTH = 4000;
export const ANSWER_MAX_LENGTH = 2000;
const MAX_OPTIONS = 10;
const OPTION_MAX_LENGTH = 120;

/** Fixed choices for a permission request, when the agent offers none. */
export const PERMISSION_OPTIONS = ["Approve", "Deny"] as const;

const ANSWER_PREFIX = "Answer:";

export interface AskInput {
  channelId: string;
  /** Seconds from now, or null to wait indefinitely - which is the default. */
  expiresIn?: number | null;
  kind?: QuestionKind;
  options?: readonly string[] | null;
  prompt: string;
}

export interface ValidatedAsk {
  expiresIn: number | null;
  kind: QuestionKind;
  options: string[] | null;
  prompt: string;
}

export type AskValidation =
  | { ok: true; input: ValidatedAsk }
  | { ok: false; reason: string };

const optionsFor = (
  kind: QuestionKind,
  given: readonly string[] | null
): string[] | null => {
  if (given && given.length > 0) {
    return [...given];
  }
  return kind === "permission" ? [...PERMISSION_OPTIONS] : null;
};

/**
 * Shape-checking that both callers share (the MCP tool now, the Slack and web
 * paths later). Tenancy is *not* checked here - `ask` does that, because the
 * channel has to be resolved within the workspace to be refused properly.
 */
export const validateAsk = (input: AskInput): AskValidation => {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    return { ok: false, reason: "The question cannot be empty." };
  }
  if (prompt.length > PROMPT_MAX_LENGTH) {
    return {
      ok: false,
      reason: `The question must be at most ${PROMPT_MAX_LENGTH} characters.`,
    };
  }

  const kind = input.kind ?? "question";
  if (!QUESTION_KINDS.includes(kind)) {
    return {
      ok: false,
      reason: `"kind" must be one of: ${QUESTION_KINDS.join(", ")}.`,
    };
  }

  const given = input.options
    ? input.options.map((option) => option.trim()).filter(Boolean)
    : null;
  if (given && given.length > MAX_OPTIONS) {
    return { ok: false, reason: `At most ${MAX_OPTIONS} options.` };
  }
  if (given?.some((option) => option.length > OPTION_MAX_LENGTH)) {
    return {
      ok: false,
      reason: `Each option must be at most ${OPTION_MAX_LENGTH} characters.`,
    };
  }
  // A permission request always has buttons: "Approve"/"Deny" unless the agent
  // named its own, which it may - the kind is about how the card reads, not
  // about the words on it.
  const options = optionsFor(kind, given);

  return {
    input: { expiresIn: input.expiresIn ?? null, kind, options, prompt },
    ok: true,
  };
};

// --- reads -------------------------------------------------------------------

export const getQuestion = async (
  db: Db,
  workspaceId: string,
  id: string
): Promise<AgentQuestion | undefined> => {
  const [question] = await db
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.workspaceId, workspaceId),
        eq(agentQuestions.id, id)
      )
    );
  return question;
};

/**
 * A question the *asking agent* may look at: its own workspace and its own
 * question. Another agent's id in the same workspace resolves to nothing, the
 * same as an id that never existed - `check_answer` must not become a way to
 * enumerate what the agent next door is waiting on.
 */
export const getQuestionForAgent = async (
  db: Db,
  workspaceId: string,
  agentId: string,
  id: string
): Promise<AgentQuestion | undefined> => {
  const [question] = await db
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.workspaceId, workspaceId),
        eq(agentQuestions.agentId, agentId),
        eq(agentQuestions.id, id)
      )
    );
  return question;
};

export const listQuestions = (
  db: Db,
  workspaceId: string,
  options: { status?: AgentQuestion["status"] } = {}
): Promise<AgentQuestion[]> =>
  db
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.workspaceId, workspaceId),
        options.status ? eq(agentQuestions.status, options.status) : undefined
      )
    )
    .orderBy(desc(agentQuestions.createdAt));

export const listQuestionsForAgent = (
  db: Db,
  workspaceId: string,
  agentId: string,
  options: { limit?: number } = {}
): Promise<AgentQuestion[]> =>
  db
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.workspaceId, workspaceId),
        eq(agentQuestions.agentId, agentId)
      )
    )
    .orderBy(desc(agentQuestions.createdAt))
    .limit(options.limit ?? 50);

/**
 * Pending counts per agent for the rail's badge - one grouped query for the
 * whole workspace, however many agents it has.
 *
 * Read-only on purpose: a row whose expiry has passed is not counted, but it is
 * not resolved either. Resolving belongs to the paths that act on a question
 * (and to the sweep); a badge must not post messages.
 */
export const countPendingQuestionsByAgent = async (
  db: Db,
  workspaceId: string,
  now: Date = new Date()
): Promise<Map<string, number>> => {
  const rows = await db
    .select({
      agentId: agentQuestions.agentId,
      pending: sql<number>`count(*)`,
    })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.workspaceId, workspaceId),
        eq(agentQuestions.status, "pending"),
        sql`(${agentQuestions.expiresAt} IS NULL OR ${agentQuestions.expiresAt} > ${now.getTime()})`
      )
    )
    .groupBy(agentQuestions.agentId);
  return new Map(rows.map((row) => [row.agentId, Number(row.pending)]));
};

export const countPendingQuestionsForAgent = async (
  db: Db,
  workspaceId: string,
  agentId: string,
  now: Date = new Date()
): Promise<number> =>
  (await countPendingQuestionsByAgent(db, workspaceId, now)).get(agentId) ?? 0;

/** Every question of one workspace, for the workspace-delete cleanup. */
export const deleteQuestionsForWorkspace = async (
  db: Db,
  workspaceId: string
): Promise<void> => {
  await db
    .delete(agentQuestions)
    .where(eq(agentQuestions.workspaceId, workspaceId));
};

// --- asking ------------------------------------------------------------------

export interface AskingAgent {
  id: string;
  name: string;
}

export type AskResult =
  | { ok: true; message: MessageView; question: AgentQuestion }
  | { ok: false; reason: string };

/**
 * Posts the question card and records the row against it.
 *
 * The agent is added to the channel first, as `fireRoutine` does: membership is
 * what the router reads to decide who may be woken, and an agent that cannot be
 * woken could never be answered. Callers that must not widen an agent's reach -
 * the MCP tool - check membership *before* calling, so this join only ever
 * re-states something already true.
 */
export const ask = async (
  db: Db,
  env: Env,
  workspace: WorkspaceRef,
  agent: AskingAgent,
  input: AskInput
): Promise<AskResult> => {
  const validated = validateAsk(input);
  if (!validated.ok) {
    return validated;
  }
  const { expiresIn, kind, options, prompt } = validated.input;

  const channel = await getChannel(db, workspace.id, input.channelId);
  if (!channel) {
    return { ok: false, reason: "No such channel in this workspace." };
  }

  await addChannelMember(db, channel.id, {
    memberId: agent.id,
    memberType: "agent",
  });

  const posted = await createMessage(db, {
    authorId: agent.id,
    authorType: "agent",
    body: prompt,
    channelId: channel.id,
    origin: QUESTION_ORIGIN,
    workspace,
  });
  if (!posted.ok) {
    return { ok: false, reason: posted.reason };
  }

  const [question] = await db
    .insert(agentQuestions)
    .values({
      agentId: agent.id,
      channelId: channel.id,
      expiresAt:
        expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000),
      id: crypto.randomUUID(),
      kind,
      messageId: posted.message.id,
      options: options ? JSON.stringify(options) : null,
      prompt,
      workspaceId: workspace.id,
    })
    .returning();
  if (!question) {
    throw new Error("Failed to record the question.");
  }

  // Re-read *after* the row exists: the message that reaches open clients and
  // the Slack mirror has to already be a question card, not a plain post.
  const message =
    (await getMessageView(db, workspace, posted.message.id)) ?? posted.message;
  await fanOutMessage(db, env, message);

  return { message, ok: true, question };
};

// --- answering ---------------------------------------------------------------

/** Who answered: the human's message authorship, and the id we record. */
export interface Answerer {
  /** `messages.author_id` - a Clerk user id for a person, an external id else. */
  authorId: string;
  authorType: "external" | "user";
  /** `agent_questions.answered_by`: a member id, or `slack:U…`. */
  id: string;
  via: AnswerSurface;
}

export type AnswerResult =
  | { ok: true; question: AgentQuestion }
  | { ok: false; question: AgentQuestion; reason: "already-resolved" }
  | { ok: false; reason: "invalid-option" };

/**
 * The one place a resolution leaves this module, whichever resolved it: the
 * answer route, a Slack button, the expiry sweep. It hands the replacement view
 * to the fan-out, which is what puts it in front of open clients *and* rewrites
 * the card on any bridged surface - so the two renderers cannot drift apart.
 */
const broadcastQuestion = async (
  db: Db,
  env: Env,
  workspaceId: string,
  question: AgentQuestion
): Promise<void> => {
  const [view] = await toQuestionViews(db, workspaceId, [question]);
  if (!view) {
    return;
  }
  await fanOutQuestionUpdate(db, env, {
    messageId: question.messageId,
    question: view satisfies QuestionView,
  });
};

/**
 * The reply that resolves a question, in the question's own thread. The body is
 * `@Agent Answer: …` for the same reason a routine's firing message mentions
 * the agent: the mention is what the router turns into a wake, so the agent
 * reads the answer with the question above it.
 */
const postResolution = async (
  db: Db,
  env: Env,
  workspace: WorkspaceRef,
  question: AgentQuestion,
  author: { authorId: string; authorType: "agent" | "external" | "user" },
  text: string
): Promise<void> => {
  const agent = await getAgentById(db, workspace.id, question.agentId);
  if (!agent) {
    // The agent was deleted while the question waited: there is nobody to wake
    // and no name to mention, and the row is already resolved.
    return;
  }
  await publishMessage(db, env, {
    authorId: author.authorId,
    authorType: author.authorType,
    body: `@${agent.name} ${ANSWER_PREFIX} ${text}`,
    channelId: question.channelId,
    origin: ANSWER_ORIGIN,
    threadParentId: question.messageId,
    workspace,
  });
};

export const answerQuestion = async (
  db: Db,
  env: Env,
  workspace: WorkspaceRef,
  question: AgentQuestion,
  input: { answer: string; by: Answerer }
): Promise<AnswerResult> => {
  const answer = input.answer.trim().slice(0, ANSWER_MAX_LENGTH);
  const options = optionsOf(question);
  if (options && !options.includes(answer)) {
    return { ok: false, reason: "invalid-option" };
  }
  if (answer.length === 0) {
    return { ok: false, reason: "invalid-option" };
  }

  // The race, settled by the database: `status = 'pending'` in the WHERE means
  // the second answer updates nothing and gets no row back.
  const [updated] = await db
    .update(agentQuestions)
    .set({
      answer,
      answeredAt: new Date(),
      answeredBy: input.by.id,
      answeredVia: input.by.via,
      status: "answered",
    })
    .where(
      and(
        eq(agentQuestions.id, question.id),
        eq(agentQuestions.status, "pending")
      )
    )
    .returning();

  if (!updated) {
    const current = await getQuestion(db, question.workspaceId, question.id);
    return {
      ok: false,
      question: current ?? question,
      reason: "already-resolved",
    };
  }

  await postResolution(db, env, workspace, updated, input.by, answer);
  await broadcastQuestion(db, env, workspace.id, updated);
  return { ok: true, question: updated };
};

// --- expiry ------------------------------------------------------------------

/**
 * The expired resolution: same conditional update, so a question that is being
 * answered at this exact moment is not stolen from under the answerer.
 *
 * The notice is authored `external`, exactly as a routine's firing message is:
 * an agent is never woken by its own post, so the one thing the notice must not
 * be is a message from the agent itself.
 */
export const expireQuestion = async (
  db: Db,
  env: Env,
  workspace: WorkspaceRef,
  question: AgentQuestion
): Promise<AgentQuestion | undefined> => {
  const [updated] = await db
    .update(agentQuestions)
    .set({ answeredAt: new Date(), status: "expired" })
    .where(
      and(
        eq(agentQuestions.id, question.id),
        eq(agentQuestions.status, "pending")
      )
    )
    .returning();
  if (!updated) {
    return;
  }

  await postResolution(
    db,
    env,
    workspace,
    updated,
    { authorId: `${QUESTION_ORIGIN}:${updated.id}`, authorType: "external" },
    "(expired - nobody answered in time, so proceed with your best default.)"
  );
  await broadcastQuestion(db, env, workspace.id, updated);
  return updated;
};

const isDue = (question: AgentQuestion, now: Date): boolean =>
  question.status === "pending" &&
  question.expiresAt !== null &&
  question.expiresAt.getTime() <= now.getTime();

/**
 * Lazy expiry: anything that *acts* on a question resolves it first, so an
 * answer can never land on a question whose time has gone. The sweep below is
 * the same thing on a timer, for the questions nobody looks at.
 */
export const resolveIfExpired = async (
  db: Db,
  env: Env,
  workspace: WorkspaceRef,
  question: AgentQuestion,
  now: Date = new Date()
): Promise<AgentQuestion> => {
  if (!isDue(question, now)) {
    return question;
  }
  return (await expireQuestion(db, env, workspace, question)) ?? question;
};

export const resolveExpiries = async (
  db: Db,
  env: Env,
  workspace: WorkspaceRef,
  questions: readonly AgentQuestion[],
  now: Date = new Date()
): Promise<AgentQuestion[]> => {
  const resolved: AgentQuestion[] = [];
  for (const question of questions) {
    // Each expiry posts a message; they resolve in the order they were asked
    // rather than racing each other into the channel.
    // biome-ignore lint/performance/noAwaitInLoops: each resolution posts a message, in order
    resolved.push(await resolveIfExpired(db, env, workspace, question, now));
  }
  return resolved;
};

/** The workspace's earliest pending expiry, or null when nothing is armed. */
export const earliestQuestionExpiry = async (
  db: Db,
  workspaceId: string
): Promise<Date | null> => {
  const [row] = await db
    .select({ expiresAt: agentQuestions.expiresAt })
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.workspaceId, workspaceId),
        eq(agentQuestions.status, "pending"),
        isNotNull(agentQuestions.expiresAt)
      )
    )
    .orderBy(asc(agentQuestions.expiresAt))
    .limit(1);
  return row?.expiresAt ?? null;
};

/**
 * Every question whose time has come, resolved. Called from the per-workspace
 * scheduler's alarm - the observer of last resort, for the question nobody has
 * looked at since it was asked.
 */
export const sweepExpiredQuestions = async (
  db: Db,
  env: Env,
  workspace: WorkspaceRef,
  now: Date = new Date()
): Promise<AgentQuestion[]> => {
  const due = await db
    .select()
    .from(agentQuestions)
    .where(
      and(
        eq(agentQuestions.workspaceId, workspace.id),
        eq(agentQuestions.status, "pending"),
        isNotNull(agentQuestions.expiresAt),
        lte(agentQuestions.expiresAt, now)
      )
    )
    .orderBy(asc(agentQuestions.expiresAt));

  const expired: AgentQuestion[] = [];
  for (const question of due) {
    // In turn: each one posts into a channel, and they should read in the
    // order they ran out.
    // biome-ignore lint/performance/noAwaitInLoops: each expiry posts a message, in order
    const resolved = await expireQuestion(db, env, workspace, question).catch(
      () => undefined
    );
    if (resolved) {
      expired.push(resolved);
    }
  }
  return expired;
};
