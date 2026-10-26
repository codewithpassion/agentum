import type { runRequests } from "@repo/db/schema/requests";
import { ANSWER_SURFACES } from "@repo/db/shared";
import type { Masker } from "@repo/protocol/masker";
import {
  type ApprovalAnswer,
  approvalAnswerSchema,
  approvalDisplaySchema,
  type QuestionAnswer,
  questionAnswerSchema,
  questionDisplaySchema,
  requestOutcomeSchema,
  type TakeoverAnswer,
} from "@repo/protocol/requests";
import { z } from "zod";
import { payloadSchema } from "../events/payload.ts";
import { redactText } from "../events/scrub.ts";

const id = z.string().min(1).max(200);
const base = { runId: id, toolName: id, toolUseId: id };
export const openInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...base,
    input: payloadSchema,
    kind: z.literal("approval"),
    toolKey: id.optional(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("question"),
    questions: questionDisplaySchema.shape.questions,
  }),
]);
export const answerInputSchema = z.strictObject({
  answer: z.union([approvalAnswerSchema, questionAnswerSchema]),
  requestId: id,
  via: z.enum(ANSWER_SURFACES),
});
export type RequestRow = typeof runRequests.$inferSelect;
export const outcomeOf = (row: RequestRow) =>
  row.status === "pending"
    ? null
    : requestOutcomeSchema.parse({
        status: row.status,
        ...(row.answer ? { answer: JSON.parse(row.answer) } : {}),
      });
/** The record a runtime gets: the answer is raw, as the person typed it. */
export const requestRecord = (row: RequestRow) => {
  // V6.7 teaches the services and the desk to read a takeover row. Nothing
  // opens one before then, so a takeover here is a bug worth failing on.
  if (row.kind === "takeover") {
    throw new Error(`Request ${row.id} is a takeover, which is not read yet`);
  }
  const { questionKeys: _keys, ...rest } = row;
  return {
    ...rest,
    answer: row.answer
      ? answerInputSchema.shape.answer.parse(JSON.parse(row.answer))
      : null,
    display:
      row.kind === "approval"
        ? approvalDisplaySchema.parse(JSON.parse(row.display))
        : questionDisplaySchema.parse(JSON.parse(row.display)),
    kind: row.kind,
    outcome: outcomeOf(row),
  };
};
export type RequestRecord = ReturnType<typeof requestRecord>;

type MaskText = Pick<Masker, "mask">;
export const scrubText = (masker: MaskText | null, text: string) =>
  redactText(masker ? masker.mask(text) : text);

/** The answer with granted secrets masked and token shapes redacted, for events and for people. */
export const scrubAnswer = <
  T extends ApprovalAnswer | QuestionAnswer | TakeoverAnswer,
>(
  answer: T,
  masker: MaskText | null
): T => {
  if ("decision" in answer || !("answers" in answer)) {
    return {
      ...answer,
      ...(answer.note === undefined
        ? {}
        : { note: scrubText(masker, answer.note) }),
    };
  }
  return {
    answers: Object.fromEntries(
      Object.entries(answer.answers).map(([question, text]) => [
        scrubText(masker, question),
        scrubText(masker, text),
      ])
    ),
  } as T;
};

/** The record with its answer scrubbed, for a web or Slack client. */
export const scrubbedRecord = (row: RequestRow, masker: MaskText | null) => {
  const record = requestRecord(row);
  return {
    ...record,
    answer: record.answer && scrubAnswer(record.answer, masker),
    outcome:
      record.outcome?.status === "answered"
        ? {
            ...record.outcome,
            answer: scrubAnswer(record.outcome.answer, masker),
          }
        : record.outcome,
  };
};

/** Answers keyed by the question text the runtime asked, not the text shown. */
export const runtimeAnswers = (
  row: RequestRow,
  answer: QuestionAnswer
): QuestionAnswer => {
  if (!row.questionKeys) {
    return answer;
  }
  const asked = z.array(z.string()).parse(JSON.parse(row.questionKeys));
  const shown = questionDisplaySchema
    .parse(JSON.parse(row.display))
    .questions.map(({ question }) => question);
  return {
    answers: Object.fromEntries(
      Object.entries(answer.answers).map(([question, text]) => [
        asked[shown.indexOf(question)] ?? question,
        text,
      ])
    ),
  };
};

/** V1.1 caps input at 8192 UTF-8 bytes. Oversized JSON becomes a valid JSON preview. */
export const capInput = (input: z.infer<typeof payloadSchema>) => {
  const serialized = JSON.stringify(input);
  if (new TextEncoder().encode(serialized).length <= 8192) {
    return input;
  }
  // Worst case each preview character takes six bytes when JSON-escaped.
  return `${serialized.slice(0, 1300)}… [truncated]`;
};
