import { describe, expect, test } from "bun:test";
import type { Question } from "./api";
import { oldestPending, optionTone, questionCardState } from "./question-card";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const question = (over: Partial<Question> = {}): Question => ({
  agentId: "agt_1",
  answer: null,
  answeredAt: null,
  answeredBy: null,
  answeredVia: null,
  channelId: "chan_1",
  createdAt: NOW,
  expiresAt: null,
  id: "qst_1",
  kind: "question",
  messageId: "msg_1",
  options: ["Yes", "No"],
  prompt: "Ship it?",
  status: "pending",
  ...over,
});

describe("questionCardState", () => {
  test("a pending question is answerable", () => {
    const state = questionCardState(question(), { now: NOW });
    expect(state.mode).toBe("pending");
    expect(state.disabled).toBe(false);
    expect(state.resolutionLabel).toBeNull();
  });

  test("an in-flight answer disables the buttons before the server replies", () => {
    expect(
      questionCardState(question(), { busy: true, now: NOW }).disabled
    ).toBe(true);
  });

  test("an answered question is disabled and says who answered", () => {
    const state = questionCardState(
      question({
        answer: "Yes",
        answeredAt: NOW - 3 * MINUTE,
        answeredBy: { id: "mem_1", name: "Ada" },
        answeredVia: "web",
        status: "answered",
      }),
      { now: NOW }
    );
    expect(state.disabled).toBe(true);
    expect(state.resolutionLabel).toBe("Answered by Ada · 3m ago");
  });

  test("a Slack answer names the surface it came from", () => {
    const state = questionCardState(
      question({
        answer: "Yes",
        answeredAt: NOW,
        answeredBy: { id: "slack:U1", name: "Ada" },
        answeredVia: "slack",
        status: "answered",
      }),
      { now: NOW }
    );
    expect(state.resolutionLabel).toBe(
      "Answered by Ada (via Slack) · just now"
    );
  });

  test("a raw Slack id is never shown as a name", () => {
    const state = questionCardState(
      question({
        answeredAt: NOW,
        answeredBy: { id: "slack:U01AB2CD3EF", name: "U01AB2CD3EF" },
        answeredVia: "slack",
        status: "answered",
      }),
      { now: NOW }
    );
    expect(state.resolutionLabel).toBe(
      "Answered by someone on Slack · just now"
    );
  });

  test("an expired question says so and takes its buttons away", () => {
    const state = questionCardState(question({ status: "expired" }), {
      now: NOW,
    });
    expect(state.mode).toBe("expired");
    expect(state.disabled).toBe(true);
    expect(state.resolutionLabel).toContain("Expired");
  });

  test("a deadline reads as a countdown while the question waits", () => {
    expect(
      questionCardState(question({ expiresAt: NOW + 12 * MINUTE }), {
        now: NOW,
      }).expiryLabel
    ).toBe("expires in 12m");
  });

  test("a passed deadline still reads pending - the server closes it, not the card", () => {
    const state = questionCardState(question({ expiresAt: NOW - MINUTE }), {
      now: NOW,
    });
    expect(state.mode).toBe("pending");
    expect(state.disabled).toBe(false);
  });

  test("a resolved question drops the countdown", () => {
    expect(
      questionCardState(
        question({ expiresAt: NOW + MINUTE, status: "answered" }),
        { now: NOW }
      ).expiryLabel
    ).toBeNull();
  });

  test("no options means the answer is typed", () => {
    expect(questionCardState(question({ options: null })).freeText).toBe(true);
  });
});

describe("optionTone", () => {
  const permission = question({ kind: "permission" });

  test("approval and denial are read off a permission request", () => {
    expect(optionTone(permission, "Approve")).toBe("primary");
    expect(optionTone(permission, "deny")).toBe("danger");
  });

  test("an unrecognised permission option stays neutral", () => {
    expect(optionTone(permission, "Ask me later")).toBe("neutral");
  });

  test("a plain question never takes a side", () => {
    expect(optionTone(question(), "Approve")).toBe("neutral");
    expect(optionTone(question(), "Deny")).toBe("neutral");
  });
});

describe("oldestPending", () => {
  test("picks the longest-waiting question", () => {
    const picked = oldestPending([
      question({ createdAt: NOW, id: "qst_new" }),
      question({ createdAt: NOW - MINUTE, id: "qst_old" }),
    ]);
    expect(picked?.id).toBe("qst_old");
  });

  test("ignores questions that are already resolved", () => {
    const picked = oldestPending([
      question({ createdAt: NOW - MINUTE, id: "qst_done", status: "answered" }),
      question({ createdAt: NOW, id: "qst_waiting" }),
    ]);
    expect(picked?.id).toBe("qst_waiting");
  });

  test("answers with nothing when none are waiting", () => {
    expect(oldestPending([question({ status: "expired" })])).toBeNull();
  });
});
