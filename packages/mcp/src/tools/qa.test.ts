import { describe, expect, test } from "bun:test";
import { QA_BODY_MAX, QA_STATUSES, QA_TITLE_MAX } from "@repo/db/shared";
import type { QaAnswerInfo, QaPort, QaQuestionInfo } from "../ports";
import { ToolError } from "../result";
import { createHarbourmasterMcpServer, harbourmasterTools } from "../server";
import { connectClient, textOf } from "../testing";
import { READ_ONLY, UNTRUSTED_NOTICE, WRITE_CREATE } from "./define";
import { callTool, fakePorts } from "./library-wiki.test-helpers";

const QUESTION: QaQuestionInfo = {
  acceptedAnswerId: null,
  authorId: "agent1",
  authorKind: "agent",
  body: "Which environment should we use?",
  createdAt: "2026-10-27T00:00:00Z",
  id: "q1",
  runId: "run1",
  status: "open",
  title: "Environment",
  updatedAt: "2026-10-27T00:00:00Z",
};
const ANSWER: QaAnswerInfo = {
  authorId: "user1",
  authorKind: "user",
  body: "Use staging.",
  createdAt: QUESTION.createdAt,
  id: "a1",
  questionId: "q1",
  runId: null,
};
const fail = (): Promise<never> =>
  Promise.reject(new Error("Unexpected port call"));
const qaPorts = (overrides: Partial<QaPort> = {}) =>
  fakePorts({
    qa: { answer: fail, ask: fail, get: fail, list: fail, ...overrides },
  });
const CALLS: [string, Record<string, unknown>][] = [
  ["qa_ask", { body: "Details", title: "Question" }],
  ["qa_answer", { body: "Answer", id: "q1" }],
  ["qa_list", {}],
  ["qa_read", { id: "q1" }],
];

const qaNames = (ports = qaPorts(), options = {}) =>
  harbourmasterTools(ports, options).filter((tool) =>
    tool.name.startsWith("qa_")
  );

describe("Q&A registration", () => {
  test("requires both the option and port and retains only reads for read-only callers", () => {
    expect(qaNames()).toEqual([]);
    expect(qaNames(fakePorts(), { qa: true })).toEqual([]);
    expect(
      qaNames(qaPorts(), { qa: true })
        .map((tool) => tool.name)
        .sort()
    ).toEqual(CALLS.map(([name]) => name).sort());
    expect(
      qaNames(qaPorts(), { qa: true, readOnly: true })
        .map((tool) => tool.name)
        .sort()
    ).toEqual(["qa_list", "qa_read"]);
  });

  test("advertises annotations, shared limits and the board versus ask-user distinction", async () => {
    const { client, close } = await connectClient(
      createHarbourmasterMcpServer(qaPorts(), { qa: true })
    );
    try {
      const { tools } = await client.listTools();
      const qa = tools.filter((tool) => tool.name.startsWith("qa_"));
      expect(qa).toHaveLength(4);
      for (const tool of qa) {
        expect(tool.annotations).toEqual(
          ["qa_list", "qa_read"].includes(tool.name) ? READ_ONLY : WRITE_CREATE
        );
        expect(tool.description).toContain("board");
      }
      const ask = qa.find((tool) => tool.name === "qa_ask");
      expect(ask?.description).toContain("ask_user");
      expect(ask?.description).toContain("person running the task");
      expect(ask?.inputSchema).toMatchObject({
        properties: {
          body: { maxLength: QA_BODY_MAX },
          title: { maxLength: QA_TITLE_MAX },
        },
      });
    } finally {
      await close();
    }
  });
});

describe("Q&A results", () => {
  test("asks and answers with trimmed text and returns the created records", async () => {
    const received: unknown[] = [];
    const ports = qaPorts({
      answer: (input) => {
        received.push(input);
        return Promise.resolve(ANSWER);
      },
      ask: (input) => {
        received.push(input);
        return Promise.resolve(QUESTION);
      },
    });
    const asked = await callTool(
      ports,
      "qa_ask",
      { body: " Details ", title: " Question " },
      { qa: true }
    );
    const answered = await callTool(
      ports,
      "qa_answer",
      { body: " Answer ", id: "q1" },
      { qa: true }
    );
    expect(received).toEqual([
      { body: "Details", title: "Question" },
      { body: "Answer", id: "q1" },
    ]);
    expect(asked.isError).toBeFalsy();
    expect(asked.structuredContent).toEqual(QUESTION);
    expect(textOf(asked)).toContain("q1");
    expect(answered.isError).toBeFalsy();
    expect(answered.structuredContent).toEqual(ANSWER);
    expect(textOf(answered)).toContain("a1");
  });

  test("lists with no filter, each valid status or a cursor and reports an empty board", async () => {
    const received: unknown[] = [];
    const page = { nextCursor: "q1", questions: [QUESTION] };
    const ports = qaPorts({
      list: (input) => {
        received.push(input);
        return Promise.resolve(page);
      },
    });
    const results = await Promise.all(
      [
        {},
        ...QA_STATUSES.map((status) => ({ status })),
        { cursor: "q0", status: "open" },
      ].map((input) => callTool(ports, "qa_list", input, { qa: true }))
    );
    for (const result of results) {
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        ...page,
        notice: UNTRUSTED_NOTICE,
      });
      expect(textOf(result)).toContain(QUESTION.title);
      expect(textOf(result)).toContain(UNTRUSTED_NOTICE);
      expect(textOf(result)).toContain('pass cursor "q1"');
    }
    expect(received).toEqual([
      {},
      ...QA_STATUSES.map((status) => ({ status })),
      { cursor: "q0", status: "open" },
    ]);
    const empty = await callTool(
      qaPorts({
        list: () => Promise.resolve({ nextCursor: null, questions: [] }),
      }),
      "qa_list",
      {},
      { qa: true }
    );
    expect(textOf(empty)).toContain("No questions.");
  });

  test("reads the question, answers and accepted answer id", async () => {
    const transcript = {
      answers: [ANSWER],
      question: {
        ...QUESTION,
        acceptedAnswerId: "a1",
        status: "answered" as const,
      },
    };
    const received: unknown[] = [];
    const result = await callTool(
      qaPorts({
        get: (input) => {
          received.push(input);
          return Promise.resolve(transcript);
        },
      }),
      "qa_read",
      { id: "q1" },
      { qa: true }
    );
    expect(received).toEqual([{ id: "q1" }]);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      ...transcript,
      notice: UNTRUSTED_NOTICE,
    });
    expect(textOf(result)).toContain(UNTRUSTED_NOTICE);
    expect(textOf(result)).toContain(QUESTION.body);
    expect(textOf(result)).toContain(ANSWER.body);
    expect(textOf(result)).toContain('"acceptedAnswerId": "a1"');
  });
});

describe("Q&A validation and failures", () => {
  test.each([
    ["qa_ask", { body: "body", title: " " }],
    ["qa_ask", { body: "body", title: "x".repeat(QA_TITLE_MAX + 1) }],
    ["qa_ask", { body: " ", title: "title" }],
    ["qa_ask", { body: "x".repeat(QA_BODY_MAX + 1), title: "title" }],
    ["qa_answer", { body: " ", id: "q1" }],
    ["qa_answer", { body: "x".repeat(QA_BODY_MAX + 1), id: "q1" }],
    ["qa_answer", { body: "answer", id: "" }],
    ["qa_read", { id: "" }],
    ["qa_read", { id: "x".repeat(201) }],
    ["qa_list", { status: "pending" }],
    ["qa_list", { cursor: "" }],
    ["qa_list", { cursor: "x".repeat(201) }],
    ...CALLS.map(([name, input]) => [name, { ...input, extra: true }]),
    ...CALLS.map(([name]) => [name, { title: 42 }]),
  ] as [string, Record<string, unknown>][])(
    "%s refuses invalid arguments before calling its port",
    async (name, input) => {
      let calls = 0;
      const count = (): Promise<never> => {
        calls += 1;
        return fail();
      };
      const result = await callTool(
        qaPorts({ answer: count, ask: count, get: count, list: count }),
        name,
        input,
        { qa: true }
      );
      expect(result.isError).toBe(true);
      expect(calls).toBe(0);
    }
  );

  test("accepts exact shared text limits", async () => {
    const body = "x".repeat(QA_BODY_MAX);
    const ports = qaPorts({
      answer: () => Promise.resolve(ANSWER),
      ask: () => Promise.resolve(QUESTION),
    });
    const results = await Promise.all(
      (
        [
          ["qa_ask", { body, title: "x".repeat(QA_TITLE_MAX) }],
          ["qa_answer", { body, id: "q1" }],
        ] as const
      ).map(([name, input]) => callTool(ports, name, input, { qa: true }))
    );
    for (const result of results) {
      expect(result.isError).toBeFalsy();
    }
  });

  test.each(CALLS)(
    "%s returns port failures as tool errors and hides internal errors",
    async (name, input) => {
      await Promise.all(
        [
          new ToolError("not_found", "Question not found."),
          new Error("private database details"),
        ].map(async (error) => {
          const reject = (): Promise<never> => Promise.reject(error);
          const result = await callTool(
            qaPorts({ answer: reject, ask: reject, get: reject, list: reject }),
            name,
            input,
            { qa: true }
          );
          expect(result.isError).toBe(true);
          if (error instanceof ToolError) {
            expect(result.structuredContent).toEqual({
              code: "not_found",
              message: error.message,
            });
          } else {
            expect(textOf(result)).not.toContain(error.message);
            expect(result.structuredContent).toBeUndefined();
          }
        })
      );
    }
  );

  test.each(CALLS)("%s respects the dry-run gate", async (name, input) => {
    const skips: unknown[] = [];
    const calls: string[] = [];
    const ports = qaPorts({
      get: () => {
        calls.push("get");
        return Promise.resolve({ answers: [], question: QUESTION });
      },
      list: () => {
        calls.push("list");
        return Promise.resolve({ nextCursor: null, questions: [] });
      },
    });
    const result = await callTool(ports, name, input, {
      dryRun: {
        record: (skip) => {
          skips.push(skip);
          return Promise.resolve();
        },
      },
      qa: true,
    });
    expect(result.isError).toBeFalsy();
    if (["qa_ask", "qa_answer"].includes(name)) {
      expect(calls).toEqual([]);
      expect(skips).toEqual([{ summary: JSON.stringify(input), tool: name }]);
      expect(result.structuredContent).toEqual({ skipped: true, tool: name });
    } else {
      expect(calls).toHaveLength(1);
      expect(skips).toEqual([]);
    }
  });
});
