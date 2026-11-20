import {
  DECISION_OPTIONS_MAX,
  DECISION_OPTIONS_MIN,
  DECISIONS_MAX,
} from "@repo/db/shared";
import { z } from "zod";
import type { McpPorts } from "../ports";
import { defineTool, type ToolDefinition, WRITE_CREATE } from "./define";

const QUESTION_MAX_CHARS = 500;
const OPTION_MAX_CHARS = 200;

const questionSchema = z.strictObject({
  freeText: z
    .boolean()
    .optional()
    .describe(
      "True lets the person type their own answer instead of picking an option."
    ),
  options: z
    .array(z.string().trim().min(1).max(OPTION_MAX_CHARS))
    .min(DECISION_OPTIONS_MIN)
    .max(DECISION_OPTIONS_MAX)
    .describe(
      `Two to ${DECISION_OPTIONS_MAX} short options, each at most ${OPTION_MAX_CHARS} characters.`
    ),
  text: z
    .string()
    .trim()
    .min(1)
    .max(QUESTION_MAX_CHARS)
    .describe(
      `One question per decision, at most ${QUESTION_MAX_CHARS} characters.`
    ),
});

export const decisionsTools = (ports: McpPorts): ToolDefinition[] => {
  const { decisions } = ports;
  if (!decisions) {
    return [];
  }
  return [
    defineTool({
      annotations: WRITE_CREATE,
      description:
        "Raises up to eight decisions as one card for the people in this conversation, each with two to four options and optionally a typed answer. It returns at once and does not wait: finish your turn or carry on with other work. A person may answer some questions and leave others. When all are answered, or after 24 hours, the answers arrive as a new message in this conversation, one line per question. A person may dismiss the card, and then nothing arrives; call the tool again to raise the questions again. Use it for choices only a person can make, not for things you can look up. Peer-origin runs, hand-off children and subagents can't use it.",
      inputSchema: z.strictObject({
        questions: z
          .array(questionSchema)
          .min(1)
          .max(DECISIONS_MAX)
          .describe(
            `The decisions to raise together, one to ${DECISIONS_MAX}.`
          ),
      }),
      name: "ask_decisions",
      run: async (input) => {
        const result = await decisions.ask(input);
        return {
          data: result,
          text: `Raised ${result.count} decisions (request ${result.requestId}). Do not wait for them: end your turn or carry on. Answers arrive as a new message here, one line per question, once all are answered or by ${result.expiresAt}.`,
        };
      },
      title: "Ask several decisions",
    }),
  ];
};
