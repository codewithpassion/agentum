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

export type ToolRuntime = "claude_code" | "pi" | "managed";

const BUILTIN_KEYS: Readonly<Record<string, string>> = {
  bash: "bash",
  edit: "edit",
  multiedit: "edit",
  read: "read",
  run_script: "run_script",
  run_skill_script: "run_skill_script",
  web_fetch: "web_fetch",
  web_search: "web_search",
  webfetch: "web_fetch",
  websearch: "web_search",
  write: "write",
};

/** A rule key shared by all runtimes; MCP tool names retain their case. */
export const toolKey = ({
  runtime,
  name,
  server,
  serverKeys = [],
}: {
  runtime: ToolRuntime;
  name: string;
  server?: string;
  serverKeys?: readonly string[];
}): string => {
  if (runtime === "managed" && server !== undefined) {
    return `${server}/${name}`;
  }
  if (runtime !== "managed") {
    let match: { key: string; prefix: string } | undefined;
    for (const key of serverKeys) {
      const prefix =
        runtime === "claude_code"
          ? `mcp__${key}__`
          : `${key}_`.replaceAll(/[^A-Za-z0-9_-]/g, "_");
      if (
        name.startsWith(prefix) &&
        name.length > prefix.length &&
        (match === undefined || key.length > match.key.length)
      ) {
        match = { key, prefix };
      }
    }
    if (match !== undefined) {
      // Pi sanitises and cuts tool names (and can suffix collisions). Without a
      // tool registry the original is unrecoverable, so keep the reported suffix.
      return `${match.key}/${name.slice(match.prefix.length)}`;
    }
  }
  const lower = name.toLowerCase();
  return Object.hasOwn(BUILTIN_KEYS, lower)
    ? (BUILTIN_KEYS[lower] ?? lower)
    : lower;
};

/** Registered by cloud and managed runtimes without a schema library adapter. */
export const ASK_USER_TOOL = {
  description:
    "Ask a person a question only when you cannot continue without their answer.",
  inputSchema: {
    additionalProperties: false,
    properties: {
      choices: {
        items: { minLength: 1, type: "string" },
        maxItems: CHOICES_MAX,
        type: "array",
      },
      multiSelect: { type: "boolean" },
      question: { minLength: 1, type: "string" },
    },
    required: ["question"],
    type: "object",
  },
  name: "ask_user",
};

export const isAskUserCall = (runtime: ToolRuntime, name: string): boolean =>
  name === "ask_user" ||
  (runtime === "claude_code" && name === "AskUserQuestion");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SUMMARY_MAX = 200;

/** Input has already been scrubbed by the caller. */
export const approvalSummary = (toolName: string, input: unknown): string => {
  let summary = `Use ${toolName}`;
  if (toolName.includes("/")) {
    summary = `Call ${toolName}`;
  } else if (isRecord(input)) {
    if (
      toolName.toLowerCase() === "bash" &&
      typeof input.command === "string"
    ) {
      summary = `Run \`${input.command}\``;
    } else {
      const detail = [input.file_path, input.url, input.query].find(
        (value): value is string =>
          typeof value === "string" && value.length > 0
      );
      if (detail !== undefined) {
        summary = `${toolName} ${detail}`;
      }
    }
  }
  const line = summary.replaceAll(/[\r\n\u2028\u2029]+/g, " ");
  return line.length > SUMMARY_MAX
    ? `${line.slice(0, SUMMARY_MAX - 1)}…`
    : line;
};

/** The model sees text only when the approval does not permit the tool to run. */
export const outcomeText = (
  kind: "approval" | "question",
  outcome: RequestOutcome
): string | null => {
  if (outcome.status === "expired") {
    return kind === "approval"
      ? "Nobody answered within the time limit, so the call did not run."
      : "Nobody answered the question in time. Go on without it or stop and say what you need.";
  }
  if (outcome.status === "cancelled") {
    // Approval cancellation has no specified wording; mirror question cancellation.
    return kind === "approval"
      ? "The call was withdrawn because the run is ending."
      : "The question was withdrawn because the run is ending.";
  }
  const { answer } = outcome;
  if (kind === "approval" && "decision" in answer) {
    if (answer.decision === "deny") {
      return `A person denied this call.${answer.note ? ` ${answer.note}` : ""}`;
    }
    return null;
  }
  if (kind === "question" && "answers" in answer) {
    return Object.entries(answer.answers)
      .map(([question, text]) => `Q: ${question} A: ${text}`)
      .join("\n");
  }
  // RequestOutcome does not correlate its answer union with the caller's kind.
  throw new TypeError(`Answer does not match request kind: ${kind}`);
};

/** Filter Claude Code's answers map to questions actually asked by this call. */
export const askUserQuestionAnswers = (
  input: unknown,
  answer: QuestionAnswer
): Record<string, string> => {
  if (!(isRecord(input) && Array.isArray(input.questions))) {
    return {};
  }
  const entries: [string, string][] = [];
  for (const question of input.questions) {
    if (
      isRecord(question) &&
      typeof question.question === "string" &&
      Object.hasOwn(answer.answers, question.question)
    ) {
      const text = answer.answers[question.question];
      if (text !== undefined) {
        // QuestionAnswer already stores text, including multi-select choices joined
        // with ", ". Preserve it: splitting would corrupt free text containing commas.
        entries.push([question.question, text]);
      }
    }
  }
  return Object.fromEntries(entries);
};
