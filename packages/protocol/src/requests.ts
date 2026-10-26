// What the Worker, the daemon and the web app agree on for an approval or a
// question a run raises for a person (V1). Browser safe: no drizzle imports.

import {
  APPROVAL_DECISIONS,
  CHOICES_MAX,
  QUESTIONS_MAX,
} from "@repo/db/shared";
import { z } from "zod";

/** Most UTF-8 bytes in an approval's tool input once serialised. */
const APPROVAL_INPUT_MAX_BYTES = 8192;

const encoder = new TextEncoder();

export const questionSchema = z.strictObject({
  choices: z.array(z.string().min(1)).max(CHOICES_MAX).optional(),
  header: z.string().optional(),
  multiSelect: z.boolean().optional(),
  question: z.string().min(1),
});
export type Question = z.infer<typeof questionSchema>;

export const questionDisplaySchema = z.strictObject({
  questions: z.array(questionSchema).min(1).max(QUESTIONS_MAX),
});
export type QuestionDisplay = z.infer<typeof questionDisplaySchema>;

export const approvalDisplaySchema = z.strictObject({
  input: z
    .json()
    .refine(
      (value) =>
        encoder.encode(JSON.stringify(value)).byteLength <=
        APPROVAL_INPUT_MAX_BYTES,
      { message: `input is over ${APPROVAL_INPUT_MAX_BYTES} bytes` }
    ),
  summary: z.string().max(2000),
  toolKey: z.string(),
  toolName: z.string(),
});
export type ApprovalDisplay = z.infer<typeof approvalDisplaySchema>;

export const approvalAnswerSchema = z.strictObject({
  decision: z.enum(APPROVAL_DECISIONS),
  note: z.string().optional(),
});
export type ApprovalAnswer = z.infer<typeof approvalAnswerSchema>;

/** Maps each question's text to the answer text. Free text is always allowed. */
export const questionAnswerSchema = z.strictObject({
  answers: z.record(z.string(), z.string()),
});
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>;

export const requestOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    answer: z.union([approvalAnswerSchema, questionAnswerSchema]),
    status: z.literal("answered"),
  }),
  z.strictObject({ status: z.literal("expired") }),
  z.strictObject({ status: z.literal("cancelled") }),
]);
export type RequestOutcome = z.infer<typeof requestOutcomeSchema>;
