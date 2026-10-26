import { describe, expect, test } from "bun:test";
import {
  ASK_USER_TOOL,
  askUserQuestionAnswers,
  approvalSummary,
  isAskUserCall,
  outcomeText,
  toolKey,
  type ToolRuntime,
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


describe("toolKey", () => {
  test("normalises the built-in table across runtimes", () => {
    const aliases = {
      bash: ["Bash", "bash"],
      write: ["Write", "write"],
      edit: ["Edit", "MultiEdit", "edit"],
      read: ["Read", "read"],
      web_fetch: ["WebFetch", "web_fetch"],
      web_search: ["WebSearch", "web_search"],
      run_script: ["run_script"],
      run_skill_script: ["run_skill_script"],
    };
    const runtimes: ToolRuntime[] = ["claude_code", "pi", "managed"];
    for (const runtime of runtimes) {
      for (const [key, names] of Object.entries(aliases)) {
        for (const name of names) {
          expect(toolKey({ runtime, name })).toBe(key);
        }
      }
      expect(toolKey({ runtime, name: "UnknownTool" })).toBe("unknowntool");
    }
  });

  test("gives MCP tools the same key across runtimes", () => {
    expect(toolKey({ runtime: "claude_code", name: "mcp__github__create_issue", serverKeys: ["github"] })).toBe("github/create_issue");
    expect(toolKey({ runtime: "pi", name: "github_create_issue", serverKeys: ["github"] })).toBe("github/create_issue");
    expect(toolKey({ runtime: "managed", name: "create_issue", server: "github" })).toBe("github/create_issue");
  });

  test("prefers the longest known server key, including underscores", () => {
    expect(toolKey({ runtime: "pi", name: "my_server_create_issue", serverKeys: ["my", "my_server"] })).toBe("my_server/create_issue");
    expect(toolKey({ runtime: "claude_code", name: "mcp__my__server__Read", serverKeys: ["my", "my__server"] })).toBe("my__server/Read");
  });

  test("matches Pi sanitisation and retains its reported, possibly cut tool name", () => {
    expect(toolKey({ runtime: "pi", name: "my_server_create_issue", serverKeys: ["my.server"] })).toBe("my.server/create_issue");
    const name = `github_${"a".repeat(80)}`.slice(0, 64);
    expect(toolKey({ runtime: "pi", name, serverKeys: ["github"] })).toBe(`github/${"a".repeat(57)}`);
  });

  test("does not guess unknown servers or accept empty tool suffixes", () => {
    expect(toolKey({ runtime: "claude_code", name: "mcp__Other__Read" })).toBe("mcp__other__read");
    expect(toolKey({ runtime: "pi", name: "other_Read", serverKeys: ["github"] })).toBe("other_read");
    expect(toolKey({ runtime: "pi", name: "github_", serverKeys: ["github"] })).toBe("github_");
  });
});

describe("ask_user tool", () => {
  test("exports a plain JSON schema for one question", () => {
    expect(ASK_USER_TOOL.name).toBe("ask_user");
    expect(ASK_USER_TOOL.description).toContain("cannot continue");
    expect(JSON.parse(JSON.stringify(ASK_USER_TOOL.inputSchema))).toEqual({
      type: "object",
      properties: {
        question: { type: "string", minLength: 1 },
        choices: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 6 },
        multiSelect: { type: "boolean" },
      },
      required: ["question"],
      additionalProperties: false,
    });
  });

  test("recognises ask_user everywhere and AskUserQuestion only in Claude Code", () => {
    const runtimes: ToolRuntime[] = ["claude_code", "pi", "managed"];
    for (const runtime of runtimes) {
      expect(isAskUserCall(runtime, "ask_user")).toBe(true);
      expect(isAskUserCall(runtime, "AskUserQuestion")).toBe(runtime === "claude_code");
      expect(isAskUserCall(runtime, "bash")).toBe(false);
    }
  });
});

describe("approvalSummary", () => {
  test("summarises commands, MCP tools, and common built-in inputs on one line", () => {
    expect(approvalSummary("Bash", { command: "git push\norigin main" })).toBe("Run `git push origin main`");
    expect(approvalSummary("bash", { command: "pwd" })).toBe("Run `pwd`");
    expect(approvalSummary("github/create_issue", {})).toBe("Call github/create_issue");
    expect(approvalSummary("Read", { file_path: "README.md" })).toBe("Read README.md");
    expect(approvalSummary("WebFetch", { url: "https://example.com" })).toBe("WebFetch https://example.com");
    expect(approvalSummary("WebSearch", { query: "one\ntwo" })).toBe("WebSearch one two");
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
      expect(outcomeText("approval", { status: "answered", answer: { decision } })).toBeNull();
    }
    expect(outcomeText("approval", { status: "answered", answer: { decision: "deny" } })).toBe("A person denied this call.");
    expect(outcomeText("approval", { status: "answered", answer: { decision: "deny", note: "Use staging." } })).toBe("A person denied this call. Use staging.");
    expect(outcomeText("approval", { status: "answered", answer: { decision: "deny", note: "" } })).toBe("A person denied this call.");
  });

  test("puts each question and answer together on its own line", () => {
    expect(outcomeText("question", { status: "answered", answer: { answers: { "Database?": "D1", "Regions?": "AU, US" } } })).toBe("Q: Database? A: D1\nQ: Regions? A: AU, US");
  });

  test("explains expiry and cancellation for each kind", () => {
    expect(outcomeText("approval", { status: "expired" })).toBe("Nobody answered within the time limit, so the call did not run.");
    expect(outcomeText("question", { status: "expired" })).toBe("Nobody answered the question in time. Go on without it or stop and say what you need.");
    expect(outcomeText("question", { status: "cancelled" })).toBe("The question was withdrawn because the run is ending.");
    expect(outcomeText("approval", { status: "cancelled" })).toBe("The call was withdrawn because the run is ending.");
  });

  test("rejects an answer for the wrong request kind", () => {
    expect(() => outcomeText("approval", { status: "answered", answer: { answers: {} } })).toThrow();
    expect(() => outcomeText("question", { status: "answered", answer: { decision: "allow_once" } })).toThrow();
  });
});

describe("askUserQuestionAnswers", () => {
  test("maps single and already joined multi-select answers, omitting missing and unrelated questions", () => {
    expect(askUserQuestionAnswers({ questions: [
      { question: "Database?", options: [{ label: "D1" }], multiSelect: false },
      { question: "Regions?", multiSelect: true },
      { question: "Missing?" },
      { question: "Empty?" },
    ] }, { answers: { "Database?": "D1", "Regions?": "AU, US", "Unrelated?": "ignore", "Empty?": "" } })).toEqual({ "Database?": "D1", "Regions?": "AU, US", "Empty?": "" });
  });

  test("handles malformed runtime input without inventing question keys", () => {
    for (const input of [null, {}, { questions: [null, {}, { question: 1 }] }]) {
      expect(askUserQuestionAnswers(input, { answers: { "Database?": "D1" } })).toEqual({});
    }
  });
});
