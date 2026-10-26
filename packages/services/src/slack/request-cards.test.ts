import { describe, expect, test } from "bun:test";
import { APPROVAL_DECISIONS } from "@repo/db/shared";
import {
  approvalCard,
  modalView,
  parseInteraction,
  questionCard,
  settledCard,
} from "./request-cards.ts";

const base = {
  agentName: "Pilot",
  expiresAt: 1_800_000_000_000,
  requestId: "req1",
};
const approval = {
  ...base,
  input: { command: "echo [secret:TOKEN]" },
  summary: "Run command",
};
const question = {
  ...base,
  questions: [
    { choices: ["Here", "There"], question: "Where?" },
    { question: "Why?" },
    { choices: ["A", "B"], multiSelect: true, question: "Which?" },
  ],
};
const identity = { api_app_id: "A1", team: { id: "T1" }, user: { id: "U1" } };
const click = (action: unknown) => ({
  ...identity,
  actions: [action],
  type: "block_actions",
});

describe("request cards", () => {
  test("approval content, expiry, fallback and decision round trips", () => {
    const card = approvalCard(approval);
    expect(card.text).toContain("Pilot");
    expect(JSON.stringify(card.blocks)).toContain("<!date^1800000000^");
    expect(JSON.stringify(card.blocks)).toContain("[secret:TOKEN]");
    const actions = card.blocks.find((block) => block.type === "actions");
    expect(actions?.elements.map((button) => button.action_id)).toEqual(
      APPROVAL_DECISIONS.map((decision) => `hm_req:req1:${decision}`)
    );
    expect(actions?.elements[2]?.style).toBe("danger");
    for (const [i, decision] of APPROVAL_DECISIONS.entries()) {
      expect(parseInteraction(click(actions?.elements[i]))).toEqual({
        answer: { decision },
        appId: "A1",
        ok: true,
        requestId: "req1",
        teamId: "T1",
        userId: "U1",
      });
    }
  });

  test("input is fenced, escaped and cut including the fences", () => {
    const card = approvalCard({
      ...approval,
      input: { value: "```<&".repeat(2000) },
    });
    const code = card.blocks.find(
      (block) => block.type === "section" && block.text.text.startsWith("```")
    );
    expect(code?.type).toBe("section");
    if (code?.type !== "section") {
      throw new Error("missing input");
    }
    expect(code.text.text.length).toBeLessThanOrEqual(3000);
    expect(code.text.text.endsWith("```")).toBe(true);
    expect(code.text.text.slice(3, -3)).not.toContain("```");
  });

  test("question buttons and modal launch", () => {
    const card = questionCard(question);
    expect(card.text).toContain("Where?");
    const actions = card.blocks.filter((block) => block.type === "actions");
    expect(actions[0]?.elements.map((button) => button.action_id)).toEqual([
      "hm_req:req1:choice:0:0",
      "hm_req:req1:choice:0:1",
    ]);
    expect(parseInteraction(click(actions[0]?.elements[1]))).toMatchObject({
      answer: { answers: { "Where?": "There" } },
      ok: true,
    });
    expect(actions[1]?.elements[0]?.text.text).toBe("Answer");
    expect(parseInteraction(click(actions[1]?.elements[0]))).toEqual({
      ok: false,
      reason: "modal_required",
      requestId: "req1",
    });
  });

  test("modal has text for every question and checkboxes, then parses both", () => {
    const view = modalView(question);
    expect(view.callback_id).toBe("hm_req_modal:req1");
    expect(
      view.blocks.filter((block) => block.element.type === "plain_text_input")
    ).toHaveLength(3);
    const multi = view.blocks.find(
      (block) => block.element.type === "checkboxes"
    );
    if (multi?.element.type !== "checkboxes") {
      throw new Error("missing checkboxes");
    }
    const values = {
      c2: {
        choices: {
          selected_options: multi.element.options,
          type: "checkboxes",
        },
      },
      q0: { text: { type: "plain_text_input", value: "Here" } },
      q1: { text: { type: "plain_text_input", value: "Because" } },
      q2: { text: { type: "plain_text_input", value: null as string | null } },
    };
    const payload = {
      ...identity,
      type: "view_submission",
      view: { ...view, state: { values } },
    };
    expect(parseInteraction(payload)).toMatchObject({
      answer: {
        answers: { "Where?": "Here", "Which?": "A, B", "Why?": "Because" },
      },
      ok: true,
    });
    values.q2.text.value = "Other";
    expect(parseInteraction(payload)).toMatchObject({
      answer: { answers: { "Which?": "Other" } },
      ok: true,
    });
  });

  test("settled messages preserve content and remove buttons", () => {
    for (const decision of APPROVAL_DECISIONS) {
      const card = settledCard(approval, {
        by: "Dom",
        outcome: { answer: { decision }, status: "answered" },
        via: "web",
      });
      expect(card.blocks.some((block) => block.type === "actions")).toBe(false);
      expect(card.text).toContain("by Dom on the web");
    }
    expect(
      settledCard(question, { outcome: { status: "expired" } }).text
    ).toContain("Expired, nobody answered");
    expect(
      settledCard(question, { outcome: { status: "cancelled" } }).text
    ).toContain("Cancelled");
  });

  test("foreign and malformed payloads are ignored without throwing", () => {
    for (const payload of [
      null,
      {},
      click({ action_id: "foreign" }),
      click({ action_id: "hm_req:req1:bogus" }),
      click({ action_id: "hm_req:req1:choice:0:0", value: "bad json" }),
      {
        ...identity,
        type: "view_submission",
        view: {
          callback_id: "hm_req_modal:req1",
          private_metadata: "{}",
          state: { values: {} },
        },
      },
    ]) {
      expect(parseInteraction(payload).ok).toBe(false);
    }
  });
});
