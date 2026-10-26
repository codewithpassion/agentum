import { describe, expect, test } from "bun:test";
import type { AgentRuntime } from "@repo/db/shared";
import {
  ASK_USER_TOOL,
  approvalAnswerSchema,
  approvalDisplaySchema,
  approvalSummary,
  askUserQuestionAnswers,
  isAskUserCall,
  outcomeText,
  questionAnswerSchema,
  questionDisplaySchema,
  questionSchema,
  REQUEST_TAKEOVER_TOOL,
  requestOutcomeSchema,
  takeoverAnswerSchema,
  takeoverDisplaySchema,
  toolKey,
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

  test("accepts each answer kind, including an empty takeover answer", () => {
    for (const answer of [
      { decision: "allow_once" },
      { answers: { "Which database?": "D1" } },
      {},
      { note: "Done" },
    ]) {
      expect(
        requestOutcomeSchema.safeParse({ answer, status: "answered" }).success
      ).toBe(true);
    }
  });

  test("refuses an unknown status", () => {
    expect(requestOutcomeSchema.safeParse({ status: "lost" }).success).toBe(
      false
    );
  });
});

describe("takeover schemas", () => {
  const display = { machineId: "mac-1", reason: "Solve the CAPTCHA" };

  test("display accepts a valid display and refuses extra or missing fields", () => {
    expect(takeoverDisplaySchema.safeParse(display).success).toBe(true);
    expect(
      takeoverDisplaySchema.safeParse({ ...display, extra: true }).success
    ).toBe(false);
    expect(
      takeoverDisplaySchema.safeParse({ reason: display.reason }).success
    ).toBe(false);
    expect(
      takeoverDisplaySchema.safeParse({ machineId: display.machineId }).success
    ).toBe(false);
    expect(
      takeoverDisplaySchema.safeParse({ ...display, reason: "" }).success
    ).toBe(false);
  });

  test("answer accepts an empty object or a note and refuses extra fields", () => {
    expect(takeoverAnswerSchema.safeParse({}).success).toBe(true);
    expect(takeoverAnswerSchema.safeParse({ note: "Done" }).success).toBe(true);
    expect(takeoverAnswerSchema.safeParse({ decision: "deny" }).success).toBe(
      false
    );
  });

  test("REQUEST_TAKEOVER_TOOL exports a plain JSON schema for a reason", () => {
    expect(REQUEST_TAKEOVER_TOOL.name).toBe("request_human_takeover");
    expect(REQUEST_TAKEOVER_TOOL.description).toContain("CAPTCHA");
    expect(
      JSON.parse(JSON.stringify(REQUEST_TAKEOVER_TOOL.inputSchema))
    ).toEqual({
      additionalProperties: false,
      properties: { reason: { minLength: 1, type: "string" } },
      required: ["reason"],
      type: "object",
    });
  });
});

describe("toolKey", () => {
  test("normalises the built-in table across runtimes", () => {
    const aliases = {
      bash: ["Bash", "bash"],
      edit: ["Edit", "MultiEdit", "edit"],
      read: ["Read", "read"],
      run_script: ["run_script"],
      run_skill_script: ["run_skill_script"],
      web_fetch: ["WebFetch", "web_fetch"],
      web_search: ["WebSearch", "web_search"],
      write: ["Write", "write"],
    };
    const runtimes: AgentRuntime[] = ["machine", "cloud", "managed", "fake"];
    for (const runtime of runtimes) {
      for (const [key, names] of Object.entries(aliases)) {
        for (const name of names) {
          expect(toolKey({ name, runtime })).toBe(key);
        }
      }
      expect(toolKey({ name: "UnknownTool", runtime })).toBe("unknowntool");
    }
  });

  test("gives MCP tools the same key across runtimes", () => {
    expect(
      toolKey({
        name: "mcp__github__create_issue",
        runtime: "machine",
        serverKeys: ["github"],
      })
    ).toBe("github/create_issue");
    expect(
      toolKey({
        name: "github_create_issue",
        runtime: "cloud",
        serverKeys: ["github"],
      })
    ).toBe("github/create_issue");
    for (const runtime of ["machine", "cloud", "managed", "fake"] as const) {
      expect(toolKey({ name: "create_issue", runtime, server: "github" })).toBe(
        "github/create_issue"
      );
    }
  });

  test("checks built-in names before splitting, so a server key cannot shadow them", () => {
    expect(
      toolKey({ name: "run_script", runtime: "cloud", serverKeys: ["run"] })
    ).toBe("run_script");
  });

  test("prefers the longest known server key, including underscores", () => {
    expect(
      toolKey({
        name: "my_server_create_issue",
        runtime: "cloud",
        serverKeys: ["my", "my_server"],
      })
    ).toBe("my_server/create_issue");
    expect(
      toolKey({
        name: "mcp__my__server__Read",
        runtime: "machine",
        serverKeys: ["my", "my__server"],
      })
    ).toBe("my__server/Read");
  });

  test("matches Pi sanitisation and retains its reported, possibly cut tool name", () => {
    expect(
      toolKey({
        name: "my_server_create_issue",
        runtime: "cloud",
        serverKeys: ["my.server"],
      })
    ).toBe("my.server/create_issue");
    const name = `github_${"a".repeat(80)}`.slice(0, 64);
    expect(toolKey({ name, runtime: "cloud", serverKeys: ["github"] })).toBe(
      `github/${"a".repeat(57)}`
    );
  });

  test("does not guess unknown servers or accept empty tool suffixes", () => {
    expect(toolKey({ name: "mcp__Other__Read", runtime: "machine" })).toBe(
      "mcp__other__read"
    );
    expect(
      toolKey({ name: "other_Read", runtime: "cloud", serverKeys: ["github"] })
    ).toBe("other_read");
    expect(
      toolKey({ name: "github_", runtime: "cloud", serverKeys: ["github"] })
    ).toBe("github_");
  });
});

describe("ask_user tool", () => {
  test("exports a plain JSON schema for one question", () => {
    expect(ASK_USER_TOOL.name).toBe("ask_user");
    expect(ASK_USER_TOOL.description).toContain("cannot continue");
    expect(JSON.parse(JSON.stringify(ASK_USER_TOOL.inputSchema))).toEqual({
      additionalProperties: false,
      properties: {
        choices: {
          items: { minLength: 1, type: "string" },
          maxItems: 6,
          type: "array",
        },
        multiSelect: { type: "boolean" },
        question: { minLength: 1, type: "string" },
      },
      required: ["question"],
      type: "object",
    });
  });

  test("recognises ask_user everywhere and AskUserQuestion only in Claude Code", () => {
    const runtimes: AgentRuntime[] = ["machine", "cloud", "managed", "fake"];
    for (const runtime of runtimes) {
      expect(isAskUserCall(runtime, "ask_user")).toBe(true);
      expect(isAskUserCall(runtime, "AskUserQuestion")).toBe(
        runtime === "machine"
      );
      expect(isAskUserCall(runtime, "bash")).toBe(false);
    }
  });
});

describe("approvalSummary", () => {
  test("summarises commands, MCP tools, and common built-in inputs on one line", () => {
    expect(approvalSummary("Bash", { command: "git push\norigin main" })).toBe(
      "Run `git push origin main`"
    );
    expect(approvalSummary("bash", { command: "pwd" })).toBe("Run `pwd`");
    expect(approvalSummary("github/create_issue", {})).toBe(
      "Call github/create_issue"
    );
    expect(approvalSummary("Read", { file_path: "README.md" })).toBe(
      "Read README.md"
    );
    expect(approvalSummary("WebFetch", { url: "https://example.com" })).toBe(
      "WebFetch https://example.com"
    );
    expect(approvalSummary("WebSearch", { query: "one\ntwo" })).toBe(
      "WebSearch one two"
    );
    for (const input of [null, [], "text", {}, { file_path: 3 }]) {
      expect(approvalSummary("Unknown", input)).toBe("Use Unknown");
    }
  });

  test("caps at 200 characters including the ellipsis", () => {
    const summary = approvalSummary("Bash", { command: "x".repeat(250) });
    expect(summary).toHaveLength(200);
    expect(summary.endsWith("…")).toBe(true);
    expect(approvalSummary("x".repeat(196), {})).toHaveLength(200);
    expect(approvalSummary("x".repeat(196), {}).endsWith("…")).toBe(false);
  });
});

describe("outcomeText", () => {
  test("allows approvals silently and includes denial notes", () => {
    for (const decision of ["allow_once", "always_allow"] as const) {
      expect(
        outcomeText("approval", { answer: { decision }, status: "answered" })
      ).toBeNull();
    }
    expect(
      outcomeText("approval", {
        answer: { decision: "deny" },
        status: "answered",
      })
    ).toBe("A person denied this call.");
    expect(
      outcomeText("approval", {
        answer: { decision: "deny", note: "Use staging." },
        status: "answered",
      })
    ).toBe("A person denied this call. Use staging.");
    expect(
      outcomeText("approval", {
        answer: { decision: "deny", note: "" },
        status: "answered",
      })
    ).toBe("A person denied this call.");
  });

  test("puts each question and answer together on its own line", () => {
    expect(
      outcomeText("question", {
        answer: { answers: { "Database?": "D1", "Regions?": "AU, US" } },
        status: "answered",
      })
    ).toBe("Q: Database? A: D1\nQ: Regions? A: AU, US");
  });

  test("explains expiry and cancellation for each kind", () => {
    expect(outcomeText("approval", { status: "expired" })).toBe(
      "Nobody answered within the time limit, so the call did not run."
    );
    expect(outcomeText("question", { status: "expired" })).toBe(
      "Nobody answered the question in time. Go on without it or stop and say what you need."
    );
    expect(outcomeText("question", { status: "cancelled" })).toBe(
      "The question was withdrawn because the run is ending."
    );
    expect(outcomeText("approval", { status: "cancelled" })).toBe(
      "The call was withdrawn because the run is ending."
    );
  });

  test("explains takeover answers, with and without a note", () => {
    expect(outcomeText("takeover", { answer: {}, status: "answered" })).toBe(
      "A person took over the computer and handed it back."
    );
    expect(
      outcomeText("takeover", {
        answer: { note: "Logged in as admin." },
        status: "answered",
      })
    ).toBe(
      "A person took over the computer and handed it back. Note: Logged in as admin."
    );
  });

  test("explains takeover expiry and cancellation", () => {
    expect(outcomeText("takeover", { status: "expired" })).toBe(
      "Nobody took over the computer in time. Go on without it or stop and say what you need."
    );
    expect(outcomeText("takeover", { status: "cancelled" })).toBe(
      "The person cancelled the takeover request. Go on without the computer or stop and say what you need."
    );
  });

  test("keeps approval and question outputs unchanged alongside takeover", () => {
    expect(
      outcomeText("approval", {
        answer: { decision: "allow_once" },
        status: "answered",
      })
    ).toBeNull();
    expect(outcomeText("approval", { status: "cancelled" })).toBe(
      "The call was withdrawn because the run is ending."
    );
    expect(outcomeText("question", { status: "expired" })).toBe(
      "Nobody answered the question in time. Go on without it or stop and say what you need."
    );
  });

  test("rejects an answer for the wrong request kind", () => {
    expect(() =>
      outcomeText("approval", { answer: { answers: {} }, status: "answered" })
    ).toThrow();
    expect(() =>
      outcomeText("question", {
        answer: { decision: "allow_once" },
        status: "answered",
      })
    ).toThrow();
    expect(() =>
      outcomeText("takeover", {
        answer: { decision: "allow_once" },
        status: "answered",
      })
    ).toThrow();
    expect(() =>
      outcomeText("approval", { answer: {}, status: "answered" })
    ).toThrow();
  });
});

describe("askUserQuestionAnswers", () => {
  test("maps single and already joined multi-select answers, omitting missing and unrelated questions", () => {
    expect(
      askUserQuestionAnswers(
        {
          questions: [
            {
              multiSelect: false,
              options: [{ label: "D1" }],
              question: "Database?",
            },
            { multiSelect: true, question: "Regions?" },
            { question: "Missing?" },
            { question: "Empty?" },
          ],
        },
        {
          answers: {
            "Database?": "D1",
            "Empty?": "",
            "Regions?": "AU, US",
            "Unrelated?": "ignore",
          },
        }
      )
    ).toEqual({ "Database?": "D1", "Empty?": "", "Regions?": "AU, US" });
  });

  test("handles malformed runtime input without inventing question keys", () => {
    for (const input of [
      null,
      {},
      { questions: [null, {}, { question: 1 }] },
    ]) {
      expect(
        askUserQuestionAnswers(input, { answers: { "Database?": "D1" } })
      ).toEqual({});
    }
  });
});
