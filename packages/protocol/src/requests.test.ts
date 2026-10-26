import { describe, expect, test } from "bun:test";
import {
  approvalAnswerSchema,
  approvalDisplaySchema,
  questionAnswerSchema,
  questionDisplaySchema,
  questionSchema,
  requestOutcomeSchema,
} from "./requests.ts";

const question = { question: "Which database?" };

const approval = {
  input: { command: "ls" },
  summary: "Run ls",
  toolKey: "bash",
  toolName: "Bash",
};

describe("questionSchema", () => {
  test("accepts a free text question and one with choices", () => {
    expect(questionSchema.safeParse(question).success).toBe(true);
    expect(
      questionSchema.safeParse({
        choices: ["D1", "Postgres"],
        header: "Store",
        multiSelect: false,
        question: "Which database?",
      }).success
    ).toBe(true);
  });

  test("refuses seven choices", () => {
    const choices = ["a", "b", "c", "d", "e", "f", "g"];
    expect(questionSchema.safeParse({ ...question, choices }).success).toBe(
      false
    );
  });

  test("refuses an empty question and an unknown key", () => {
    expect(questionSchema.safeParse({ question: "" }).success).toBe(false);
    expect(questionSchema.safeParse({ ...question, extra: true }).success).toBe(
      false
    );
  });
});

describe("questionDisplaySchema", () => {
  test("accepts one to four questions", () => {
    expect(
      questionDisplaySchema.safeParse({ questions: [question] }).success
    ).toBe(true);
    const four = [question, question, question, question];
    expect(questionDisplaySchema.safeParse({ questions: four }).success).toBe(
      true
    );
  });

  test("refuses a fifth question and zero questions", () => {
    const five = [question, question, question, question, question];
    expect(questionDisplaySchema.safeParse({ questions: five }).success).toBe(
      false
    );
    expect(questionDisplaySchema.safeParse({ questions: [] }).success).toBe(
      false
    );
  });
});

describe("approvalDisplaySchema", () => {
  test("accepts a good display", () => {
    expect(approvalDisplaySchema.safeParse(approval).success).toBe(true);
  });

  test("refuses a summary over 2000 characters", () => {
    const summary = "x".repeat(2001);
    expect(
      approvalDisplaySchema.safeParse({ ...approval, summary }).success
    ).toBe(false);
  });

  test("refuses input over 8 KB of UTF-8 and accepts input at the cap", () => {
    // "é" is two UTF-8 bytes. 4092 of them with the wrapper overflow 8192 bytes.
    const atCap = { text: "a".repeat(8192 - '{"text":""}'.length) };
    expect(
      approvalDisplaySchema.safeParse({ ...approval, input: atCap }).success
    ).toBe(true);
    const overBytes = { text: "é".repeat(4092) };
    expect(
      approvalDisplaySchema.safeParse({ ...approval, input: overBytes }).success
    ).toBe(false);
  });
});

describe("approvalAnswerSchema", () => {
  test("accepts each decision and refuses an unknown one", () => {
    expect(
      approvalAnswerSchema.safeParse({ decision: "allow_once" }).success
    ).toBe(true);
    expect(
      approvalAnswerSchema.safeParse({ decision: "deny", note: "no" }).success
    ).toBe(true);
    expect(approvalAnswerSchema.safeParse({ decision: "maybe" }).success).toBe(
      false
    );
  });
});

describe("questionAnswerSchema", () => {
  test("accepts answers keyed by question text", () => {
    expect(
      questionAnswerSchema.safeParse({
        answers: { "Which database?": "D1" },
      }).success
    ).toBe(true);
  });
});

describe("requestOutcomeSchema", () => {
  test("accepts answered, expired and cancelled outcomes", () => {
    expect(
      requestOutcomeSchema.safeParse({
        answer: { decision: "deny" },
        status: "answered",
      }).success
    ).toBe(true);
    expect(
      requestOutcomeSchema.safeParse({
        answer: { answers: { "Which database?": "D1" } },
        status: "answered",
      }).success
    ).toBe(true);
    expect(requestOutcomeSchema.safeParse({ status: "expired" }).success).toBe(
      true
    );
    expect(
      requestOutcomeSchema.safeParse({ status: "cancelled" }).success
    ).toBe(true);
  });

  test("refuses an unknown status", () => {
    expect(requestOutcomeSchema.safeParse({ status: "lost" }).success).toBe(
      false
    );
  });
});
