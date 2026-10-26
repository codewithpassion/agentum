// The `qa` group of the platform MCP tools: the workspace Q&A board, over the
// Q&A service, acting as the caller. The tools name a question `id`, the
// service `questionId`. Records are copied field by field so no storage
// detail (the workspace id) reaches an agent.
import type { QaAnswerInfo, QaPort, QaQuestionInfo } from "@repo/mcp/ports";
import type {
  AnswerRecord,
  QaService,
  QuestionRecord,
} from "@repo/services/qa";
import type { Principal } from "@repo/services/workspaces";
import { guarded } from "./guarded.ts";

const toQuestionInfo = (row: QuestionRecord): QaQuestionInfo => ({
  acceptedAnswerId: row.acceptedAnswerId,
  authorId: row.authorId,
  authorKind: row.authorKind,
  body: row.body,
  createdAt: row.createdAt,
  id: row.id,
  runId: row.runId,
  status: row.status,
  title: row.title,
  updatedAt: row.updatedAt,
});

const toAnswerInfo = (row: AnswerRecord): QaAnswerInfo => ({
  authorId: row.authorId,
  authorKind: row.authorKind,
  body: row.body,
  createdAt: row.createdAt,
  id: row.id,
  questionId: row.questionId,
  runId: row.runId,
});

export const createQaPorts = ({
  principal,
  services,
}: {
  principal: Principal;
  services: { qa: QaService };
}): QaPort => {
  const { qa } = services;
  return {
    answer: ({ body, id }) =>
      guarded(async () =>
        toAnswerInfo(await qa.answer(principal, { body, questionId: id }))
      ),
    ask: (input) =>
      guarded(async () => toQuestionInfo(await qa.ask(principal, input))),
    get: ({ id }) =>
      guarded(async () => {
        const { answers, question } = await qa.get(principal, id);
        return {
          answers: answers.map(toAnswerInfo),
          question: toQuestionInfo(question),
        };
      }),
    list: (input) =>
      guarded(async () => {
        const page = await qa.list(principal, input);
        return {
          nextCursor: page.nextCursor,
          questions: page.questions.map(toQuestionInfo),
        };
      }),
  };
};
