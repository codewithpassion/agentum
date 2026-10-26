import type { runRequests } from "@repo/db/schema/requests";
import { ANSWER_SURFACES, TOOL_RULE_MODES } from "@repo/db/shared";
import {
  approvalAnswerSchema,
  approvalDisplaySchema,
  questionAnswerSchema,
  questionDisplaySchema,
  requestOutcomeSchema,
} from "@repo/protocol/requests";
import { z } from "zod";
import { payloadSchema } from "../events/payload.ts";

const id = z.string().min(1).max(200);
export const pendingInputSchema = z.strictObject({ sessionId: id.optional() });
export const rulesListInputSchema = z.strictObject({ agentId: id });
export const ruleKeyInputSchema = rulesListInputSchema.extend({ toolKey: id });
export const ruleSetInputSchema = ruleKeyInputSchema.extend({
  mode: z.enum(TOOL_RULE_MODES),
});
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
export const webAnswerInputSchema = z.union([
  approvalAnswerSchema.extend({ requestId: id }),
  questionAnswerSchema.extend({ requestId: id }),
]);
export type RequestRow = typeof runRequests.$inferSelect;
export const outcomeOf = (row: RequestRow) =>
  row.status === "pending"
    ? null
    : requestOutcomeSchema.parse({
        status: row.status,
        ...(row.answer ? { answer: JSON.parse(row.answer) } : {}),
      });
export const requestRecord = (row: RequestRow) => ({
  ...row,
  answer: row.answer
    ? answerInputSchema.shape.answer.parse(JSON.parse(row.answer))
    : null,
  display:
    row.kind === "approval"
      ? approvalDisplaySchema.parse(JSON.parse(row.display))
      : questionDisplaySchema.parse(JSON.parse(row.display)),
  outcome: outcomeOf(row),
});
export type RequestRecord = ReturnType<typeof requestRecord>;

/** V1.1 caps input at 8192 UTF-8 bytes. Oversized JSON becomes a valid JSON preview. */
export const capInput = (input: z.infer<typeof payloadSchema>) => {
  const serialized = JSON.stringify(input);
  if (new TextEncoder().encode(serialized).length <= 8192) {
    return input;
  }
  // Worst case each preview character takes six bytes when JSON-escaped.
  return `${serialized.slice(0, 1300)}… [truncated]`;
};
