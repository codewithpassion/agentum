import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  readJsonObject,
  requireString,
} from "#/api/validation";
import { createDb } from "#/db/client";
import { getAgentById } from "#/modules/agents/service";
import { QUESTION_STATUSES } from "./schema";
import {
  ANSWER_MAX_LENGTH,
  answerQuestion,
  getQuestion,
  listQuestions,
  listQuestionsForAgent,
  resolveExpiries,
  resolveIfExpired,
} from "./service";
import { optionsOf, toQuestionViews } from "./view";

/**
 * The questions API, workspace-scoped like every other resource router.
 *
 * Any member may answer any question in their workspace (plan decision 3):
 * questions are asked in channels, and whoever is there first is the right
 * person to answer. What is *not* negotiable is the tenant - a question is
 * reached through `c.get("workspace").id`, so another workspace's id is a 404
 * exactly as it is everywhere else.
 *
 * Reads resolve expiry as they go: a question whose time has passed is closed
 * (and its agent woken) by the first thing that looks at it, with the
 * per-workspace scheduler's sweep as the backstop for the ones nobody opens.
 */

const CONFLICT = 409;

export const questionsRoutes = new Hono<ApiEnv>();

questionsRoutes.use("*", requireAuth);

questionsRoutes.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");

  const rawStatus = c.req.query("status");
  const status = QUESTION_STATUSES.find((known) => known === rawStatus);
  if (rawStatus !== undefined && !status) {
    throw badRequest(
      `"status" must be one of: ${QUESTION_STATUSES.join(", ")}.`
    );
  }

  const rows = await resolveExpiries(
    db,
    c.env,
    workspace,
    await listQuestions(db, workspace.id, { status })
  );
  // Re-filtered after resolution: a question that has just expired is no
  // longer part of a `status=pending` answer, and would be a card nobody can
  // use.
  const visible = status ? rows.filter((row) => row.status === status) : rows;

  return c.json({
    questions: await toQuestionViews(db, workspace.id, visible),
  });
});

questionsRoutes.post("/:id/answer", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");
  const member = c.get("member");

  const existing = await getQuestion(db, workspace.id, c.req.param("id"));
  if (!existing) {
    throw notFound("Question not found.");
  }
  const question = await resolveIfExpired(db, c.env, workspace, existing);

  const body = await readJsonObject(c.req.raw);
  const answer = requireString(body, "answer", {
    maxLength: ANSWER_MAX_LENGTH,
  });

  const result = await answerQuestion(db, c.env, workspace, question, {
    answer,
    by: {
      // The message is authored by the person; the row records their
      // *membership*, which is the id a client may see.
      authorId: member.clerkUserId,
      authorType: "user",
      id: member.id,
      via: "web",
    },
  });

  if (!result.ok) {
    if (result.reason === "invalid-option") {
      const options = optionsOf(question);
      throw badRequest(
        options
          ? `"answer" must be one of: ${options.join(", ")}.`
          : '"answer" cannot be empty.'
      );
    }
    const [view] = await toQuestionViews(db, workspace.id, [result.question]);
    const answerer = view ? view.answeredBy : null;
    return c.json(
      {
        error:
          result.question.status === "expired"
            ? "This question expired before it was answered."
            : `Already answered by ${answerer ? answerer.name : "somebody else"}.`,
        question: view,
      },
      CONFLICT
    );
  }

  const [view] = await toQuestionViews(db, workspace.id, [result.question]);
  return c.json({ question: view });
});

/**
 * `GET /agents/:id/questions` - one agent's questions, newest first. Mounted on
 * `/agents` after the agents router, the way the activity log is.
 */
export const agentQuestionsRoutes = new Hono<ApiEnv>();

agentQuestionsRoutes.use("*", requireAuth);

agentQuestionsRoutes.get("/:id/questions", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");
  const agentId = c.req.param("id");
  if (!(await getAgentById(db, workspace.id, agentId))) {
    throw notFound("Agent not found.");
  }

  const rows = await resolveExpiries(
    db,
    c.env,
    workspace,
    await listQuestionsForAgent(db, workspace.id, agentId)
  );
  return c.json({ questions: await toQuestionViews(db, workspace.id, rows) });
});
