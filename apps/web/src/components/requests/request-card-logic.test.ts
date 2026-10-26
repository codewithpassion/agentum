import { describe, expect, test } from "bun:test";
import type { ApprovalAnswer, QuestionAnswer } from "@repo/protocol/requests";
import {
  approvalAnswer,
  canSubmitAnswers,
  expiryText,
  isConflict,
  mailApprovalFields,
  questionAnswer,
  type Settled,
  settledFromEvent,
  settledLine,
  toggledChoices,
  viewFromOpened,
  viewFromRecord,
  withSendError,
} from "./request-card-logic";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;

describe("expiryText", () => {
  test("counts minutes up, so the last minute never reads 0", () => {
    expect(expiryText(at(42 * MIN), NOW)).toBe("expires in 42 min");
    expect(expiryText(at(30_000), NOW)).toBe("expires in 1 min");
  });

  test("switches to hours from an hour out", () => {
    expect(expiryText(at(60 * MIN), NOW)).toBe("expires in 1 h");
    expect(expiryText(at(23 * 60 * MIN), NOW)).toBe("expires in 23 h");
  });

  test("says expired at and after the deadline", () => {
    expect(expiryText(at(0), NOW)).toBe("expired");
    expect(expiryText(at(-5 * MIN), NOW)).toBe("expired");
    expect(expiryText("not a date", NOW)).toBe("expired");
  });
});

describe("settledLine", () => {
  const answered = (
    answer: ApprovalAnswer | QuestionAnswer,
    via: "slack" | "web" | null
  ) => ({
    answer,
    answeredBy: "user-1",
    status: "answered" as const,
    via,
  });

  test("names the decision, the person and the surface", () => {
    const allow = answered({ decision: "allow_once" }, "slack");
    expect(settledLine("approval", allow, "Dom")).toBe(
      "Allowed once by Dom in Slack"
    );
    expect(
      settledLine(
        "approval",
        answered({ decision: "always_allow" }, "web"),
        "Dom"
      )
    ).toBe("Always allowed by Dom in the web app");
  });

  test("leaves out what it does not know", () => {
    expect(
      settledLine("approval", answered({ decision: "allow_once" }, null), null)
    ).toBe("Allowed once");
  });

  test("a denial carries its note", () => {
    expect(
      settledLine(
        "approval",
        answered({ decision: "deny", note: "too risky" }, "web"),
        "Dom"
      )
    ).toBe("Denied by Dom in the web app: too risky");
  });

  test("an allow whose mail failed to send says so, with the error", () => {
    expect(
      settledLine(
        "approval",
        {
          ...answered({ decision: "allow_once" }, "web"),
          sendError: "send_failed",
        },
        "Dom"
      )
    ).toBe(
      "Allowed once by Dom in the web app, but sending failed: send_failed"
    );
    expect(
      settledLine(
        "approval",
        {
          ...answered({ decision: "always_allow" }, "slack"),
          sendError: "send_failed",
        },
        "Dom"
      )
    ).toBe("Always allowed by Dom in Slack, but sending failed: send_failed");
  });

  test("a denial ignores a send error", () => {
    expect(
      settledLine(
        "approval",
        { ...answered({ decision: "deny" }, "web"), sendError: "send_failed" },
        "Dom"
      )
    ).toBe("Denied by Dom in the web app");
  });

  test("a question reads as answered", () => {
    expect(
      settledLine("question", answered({ answers: { Q: "A" } }, "slack"), "Dom")
    ).toBe("Answered by Dom in Slack");
  });

  test("expired, cancelled and conflict need no name", () => {
    expect(settledLine("approval", { status: "expired" }, "Dom")).toBe(
      "Expired, nobody answered"
    );
    expect(settledLine("approval", { status: "cancelled" }, null)).toBe(
      "Withdrawn, the run ended"
    );
    expect(settledLine("approval", { status: "conflict" }, null)).toBe(
      "Already answered somewhere else"
    );
  });
});

describe("withSendError", () => {
  const allow: Settled = {
    answer: { decision: "allow_once" },
    answeredBy: "user-1",
    status: "answered",
    via: "web",
  };
  const deny: Settled = {
    answer: { decision: "deny" },
    answeredBy: "user-1",
    status: "answered",
    via: "web",
  };

  test("adds the error to an answered outcome", () => {
    expect(withSendError(allow, "send_failed")).toEqual({
      ...allow,
      sendError: "send_failed",
    });
  });

  test("leaves a null outcome alone, and a denial still reads as denied", () => {
    expect(withSendError(null, "send_failed")).toBeNull();
    expect(
      settledLine("approval", withSendError(deny, "send_failed") ?? deny, "Dom")
    ).toBe("Denied by Dom in the web app");
  });

  test("leaves the outcome alone when there is no error", () => {
    expect(withSendError(allow, null)).toBe(allow);
    expect(withSendError(allow, "")).toBe(allow);
  });
});

describe("approvalAnswer", () => {
  test("keeps a trimmed note on a denial only", () => {
    expect(approvalAnswer("deny", "  no thanks ")).toEqual({
      decision: "deny",
      note: "no thanks",
    });
    expect(approvalAnswer("deny", "   ")).toEqual({ decision: "deny" });
    expect(approvalAnswer("allow_once", "ignored")).toEqual({
      decision: "allow_once",
    });
  });
});

describe("question answers", () => {
  const colour = { choices: ["red", "blue"], question: "Colour?" };
  const toppings = {
    choices: ["ham", "egg", "kale"],
    multiSelect: true,
    question: "Toppings?",
  };
  const open = { question: "Anything else?" };

  test("joins picked choices and free text", () => {
    const answer = questionAnswer([colour, toppings, open], {
      choices: { "Colour?": ["blue"], "Toppings?": ["ham", "kale"] },
      text: { "Anything else?": " no onions ", "Toppings?": "pepper" },
    });
    expect(answer).toEqual({
      answers: {
        "Anything else?": "no onions",
        "Colour?": "blue",
        "Toppings?": "ham, kale, pepper",
      },
    });
  });

  test("drops a choice that is not on the question", () => {
    expect(
      questionAnswer([colour], {
        choices: { "Colour?": ["green"] },
        text: {},
      })
    ).toEqual({ answers: { "Colour?": "" } });
  });

  test("submits only when every question has an answer", () => {
    const questions = [colour, open];
    expect(
      canSubmitAnswers(questions, {
        choices: { "Colour?": ["red"] },
        text: {},
      })
    ).toBe(false);
    expect(
      canSubmitAnswers(questions, {
        choices: { "Colour?": ["red"] },
        text: { "Anything else?": "x" },
      })
    ).toBe(true);
    expect(canSubmitAnswers([], { choices: {}, text: {} })).toBe(false);
  });

  test("toggling swaps on a single choice and adds on a multi-select", () => {
    expect(toggledChoices(colour, ["red"], "blue")).toEqual(["blue"]);
    expect(toggledChoices(colour, ["red"], "red")).toEqual([]);
    expect(toggledChoices(toppings, ["ham"], "egg")).toEqual(["ham", "egg"]);
    expect(toggledChoices(toppings, ["ham", "egg"], "ham")).toEqual(["egg"]);
  });
});

describe("views from events and records", () => {
  const approval = {
    input: { command: "ls" },
    summary: "Run `ls`",
    toolKey: "bash",
    toolName: "Bash",
  };

  test("builds an approval from a request.opened payload", () => {
    const view = viewFromOpened(
      {
        display: approval,
        expiresAt: at(MIN),
        kind: "approval",
        requestId: "req-1",
      },
      "run-1",
      "entry-9"
    );
    expect(view).toEqual({
      anchorId: "entry-9",
      display: approval,
      expiresAt: at(MIN),
      id: "req-1",
      kind: "approval",
      runId: "run-1",
      settled: null,
    });
  });

  test("builds a question and rejects a payload that does not fit", () => {
    const question = { questions: [{ question: "Colour?" }] };
    expect(
      viewFromOpened(
        {
          display: question,
          expiresAt: at(MIN),
          kind: "question",
          requestId: "req-2",
        },
        "run-1",
        null
      )?.kind
    ).toBe("question");
    expect(
      viewFromOpened(
        { display: {}, expiresAt: at(MIN), kind: "approval", requestId: "r" },
        "run-1",
        null
      )
    ).toBeNull();
    expect(
      viewFromOpened(
        { display: approval, kind: "approval", requestId: "r" },
        "run-1",
        null
      )
    ).toBeNull();
    expect(
      viewFromOpened(
        {
          display: approval,
          expiresAt: at(MIN),
          kind: "approval",
          requestId: "r",
        },
        null,
        null
      )
    ).toBeNull();
  });

  test("builds the same view from a pending record", () => {
    const view = viewFromRecord(
      {
        display: approval,
        expiresAt: at(MIN),
        id: "req-1",
        kind: "approval",
        runId: "run-1",
      },
      null
    );
    expect(view?.id).toBe("req-1");
    expect(view?.settled).toBeNull();
  });
});

describe("settledFromEvent", () => {
  test("reads an approval answer", () => {
    expect(
      settledFromEvent("request.answered", {
        answeredBy: "user-1",
        decision: "deny",
        note: "no",
        requestId: "req-1",
        via: "slack",
      })
    ).toEqual({
      answer: { decision: "deny", note: "no" },
      answeredBy: "user-1",
      status: "answered",
      via: "slack",
    });
  });

  test("reads a question answer and drops non-text answers", () => {
    expect(
      settledFromEvent("request.answered", {
        answeredBy: "user-1",
        answers: { Other: 3, Q: "A" },
        via: "web",
      })
    ).toEqual({
      answer: { answers: { Q: "A" } },
      answeredBy: "user-1",
      status: "answered",
      via: "web",
    });
  });

  test("reads expiry and cancellation, and ignores other events", () => {
    expect(settledFromEvent("request.expired", {})).toEqual({
      status: "expired",
    });
    expect(settledFromEvent("request.cancelled", {})).toEqual({
      status: "cancelled",
    });
    expect(settledFromEvent("request.opened", {})).toBeNull();
    expect(settledFromEvent("request.answered", { via: "web" })).toBeNull();
  });
});

describe("isConflict", () => {
  test("is true for a tRPC CONFLICT error only", () => {
    expect(isConflict({ data: { code: "CONFLICT" } })).toBe(true);
    expect(isConflict({ data: { code: "BAD_REQUEST" } })).toBe(false);
    expect(isConflict(new Error("x"))).toBe(false);
    expect(isConflict(null)).toBe(false);
  });
});

test("takeover cards use their own display and settlement", () => {
  const record = {
    display: { machineId: "computer", reason: "Please log in" },
    expiresAt: at(MIN),
    id: "t",
    kind: "takeover" as const,
    runId: "r",
  };
  expect(viewFromRecord(record, null)).toMatchObject({
    display: record.display,
    kind: "takeover",
  });
  expect(
    settledFromEvent("request.answered", {
      answeredBy: "u",
      kind: "takeover",
      note: "done",
      via: "web",
    })
  ).toEqual({
    answer: { note: "done" },
    answeredBy: "u",
    status: "answered",
    via: "web",
  });
  expect(
    settledFromEvent("request.answered", { kind: "takeover" })
  ).toMatchObject({ answer: {}, status: "answered" });
});

describe("mailApprovalFields", () => {
  const mail = {
    cc: ["carol@example.com"],
    from: "me@example.com",
    preview: "Hi Bob,\n\nSee the attached plan.",
    subject: "Plan",
    to: ["bob@example.com"],
  };
  const display = (
    toolName: string,
    input: unknown
  ): Parameters<typeof mailApprovalFields>[0] => ({
    input: input as Parameters<typeof mailApprovalFields>[0]["input"],
    summary: "Send a mail",
    toolKey: "mail",
    toolName,
  });

  test("reads the fields of a held mail", () => {
    expect(mailApprovalFields(display("mail_send", mail))).toEqual({
      body: "Hi Bob,\n\nSee the attached plan.",
      cc: ["carol@example.com"],
      from: "me@example.com",
      subject: "Plan",
      to: ["bob@example.com"],
    });
  });

  test("an absent cc reads as none", () => {
    const { cc: _cc, ...withoutCc } = mail;
    expect(mailApprovalFields(display("mail_send", withoutCc))?.cc).toEqual([]);
  });

  test("keeps the first six lines of the preview", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
    const body = mailApprovalFields(
      display("mail_send", { ...mail, preview: lines.join("\n") })
    )?.body;
    expect(body).toBe(lines.slice(0, 6).join("\n"));
  });

  test("is null for another tool", () => {
    expect(mailApprovalFields(display("bash", mail))).toBeNull();
  });

  test("is null when the input does not have the mail shape", () => {
    expect(mailApprovalFields(display("mail_send", "text"))).toBeNull();
    expect(mailApprovalFields(display("mail_send", null))).toBeNull();
    expect(
      mailApprovalFields(display("mail_send", { ...mail, to: "bob" }))
    ).toBeNull();
    expect(
      mailApprovalFields(display("mail_send", { ...mail, cc: [1] }))
    ).toBeNull();
    expect(
      mailApprovalFields(display("mail_send", { ...mail, subject: undefined }))
    ).toBeNull();
  });
});
