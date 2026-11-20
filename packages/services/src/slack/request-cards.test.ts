import { describe, expect, test } from "bun:test";
import { APPROVAL_DECISIONS } from "@repo/db/shared";
import {
  approvalCard,
  decisionsCard,
  modalView,
  parseInteraction,
  questionCard,
  type RequestCard,
  settledCard,
  takeoverCard,
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
const single = {
  ...base,
  questions: [{ choices: ["Here", "There"], question: "Where?" }],
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
      APPROVAL_DECISIONS.map((decision) => `ag_req:req1:${decision}`)
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

  test("a peer run's approval card leaves out always allow", () => {
    const peerCard = approvalCard({ ...approval, peerRun: true });
    const actions = peerCard.blocks.find((block) => block.type === "actions");
    expect(actions?.elements.map((button) => button.action_id)).toEqual([
      "ag_req:req1:allow_once",
      "ag_req:req1:deny",
    ]);
    const plainActions = approvalCard(approval).blocks.find(
      (block) => block.type === "actions"
    );
    expect(plainActions?.elements.map((button) => button.action_id)).toEqual(
      APPROVAL_DECISIONS.map((decision) => `ag_req:req1:${decision}`)
    );
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

  test("a single question gets choice buttons that carry indices only", () => {
    const card = questionCard(single);
    expect(card.text).toContain("Where?");
    const actions = card.blocks.filter((block) => block.type === "actions");
    expect(actions[0]?.elements.map((button) => button.action_id)).toEqual([
      "ag_req:req1:choice:0:0",
      "ag_req:req1:choice:0:1",
    ]);
    expect(JSON.stringify(card.blocks)).not.toContain('"value"');
    const clicked = click(actions[0]?.elements[1]);
    expect(parseInteraction(clicked)).toEqual({
      ok: false,
      reason: "questions_required",
      requestId: "req1",
    });
    expect(parseInteraction(clicked, single.questions)).toMatchObject({
      answer: { answers: { "Where?": "There" } },
      ok: true,
    });
    expect(
      parseInteraction(
        click({ action_id: "ag_req:req1:choice:0:9" }),
        single.questions
      ).ok
    ).toBe(false);
  });

  test("several questions all go through the modal", () => {
    const card = questionCard(question);
    const actions = card.blocks.filter((block) => block.type === "actions");
    expect(actions).toHaveLength(3);
    for (const row of actions) {
      expect(row.elements.map((button) => button.action_id)).toEqual([
        "ag_req:req1:modal",
      ]);
      expect(row.elements[0]?.text.text).toBe("Answer");
    }
    expect(
      parseInteraction({
        ...click(actions[1]?.elements[0]),
        trigger_id: "trig",
      })
    ).toEqual({
      appId: "A1",
      ok: false,
      reason: "modal_required",
      requestId: "req1",
      teamId: "T1",
      triggerId: "trig",
      userId: "U1",
    });
  });

  test("modal has text for every question, radios and checkboxes, then parses", () => {
    const view = modalView(question);
    expect(view.callback_id).toBe("ag_req_modal:req1");
    expect(JSON.stringify(view)).not.toContain("private_metadata");
    expect(
      view.blocks.filter((block) => block.element.type === "plain_text_input")
    ).toHaveLength(3);
    const multi = view.blocks.find(
      (block) => block.element.type === "checkboxes"
    );
    const radio = view.blocks.find(
      (block) => block.element.type === "radio_buttons"
    );
    if (multi?.element.type !== "checkboxes" || !radio) {
      throw new Error("missing choice inputs");
    }
    const values = {
      c0: {
        choice: {
          selected_option: { value: "0" },
          type: "radio_buttons",
        },
      },
      c2: {
        choices: {
          selected_options: multi.element.options,
          type: "checkboxes",
        },
      },
      q0: { text: { type: "plain_text_input", value: null as string | null } },
      q1: { text: { type: "plain_text_input", value: "Because" } },
      q2: { text: { type: "plain_text_input", value: null as string | null } },
    };
    const payload = {
      ...identity,
      type: "view_submission",
      view: { ...view, state: { values } },
    };
    expect(parseInteraction(payload)).toEqual({
      ok: false,
      reason: "questions_required",
      requestId: "req1",
    });
    expect(parseInteraction(payload, question.questions)).toMatchObject({
      answer: {
        answers: { "Where?": "Here", "Which?": "A, B", "Why?": "Because" },
      },
      ok: true,
    });
    values.q2.text.value = "Other";
    expect(parseInteraction(payload, question.questions)).toMatchObject({
      answer: { answers: { "Which?": "Other" } },
      ok: true,
    });
    values.q1.text.value = "";
    expect(parseInteraction(payload, question.questions).ok).toBe(false);
  });

  test("long agent text keeps buttons and modal inside Slack limits", () => {
    const long = "x".repeat(5000);
    const big = {
      ...base,
      questions: [{ choices: [long, "b"], question: long }],
    };
    const card = questionCard(big);
    expect(JSON.stringify(card.blocks)).not.toContain(long);
    expect(JSON.stringify(modalView(big))).not.toContain(long);
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

  test("cards posted before the rename, with hm_req ids, still answer", () => {
    expect(
      parseInteraction(click({ action_id: "hm_req:req1:deny" }))
    ).toMatchObject({
      answer: { decision: "deny" },
      ok: true,
      requestId: "req1",
    });
    expect(
      parseInteraction(
        click({ action_id: "hm_req:req1:choice:0:1" }),
        single.questions
      )
    ).toMatchObject({ answer: { answers: { "Where?": "There" } }, ok: true });
    expect(
      parseInteraction(
        {
          ...identity,
          type: "view_submission",
          view: {
            callback_id: "hm_req_modal:req1",
            state: {
              values: {
                c0: {
                  choice: {
                    selected_option: { value: "0" },
                    type: "radio_buttons",
                  },
                },
                q0: { text: { type: "plain_text_input", value: null } },
              },
            },
          },
        },
        single.questions
      )
    ).toMatchObject({ answer: { answers: { "Where?": "Here" } }, ok: true });
    expect(parseInteraction(click({ action_id: "xx_req:req1:deny" })).ok).toBe(
      false
    );
  });

  test("foreign and malformed payloads are ignored without throwing", () => {
    for (const payload of [
      null,
      {},
      click({ action_id: "foreign" }),
      click({ action_id: "ag_req:req1:bogus" }),
      click({ action_id: "ag_req:req1:choice:0" }),
      {
        ...identity,
        type: "view_submission",
        view: {
          callback_id: "ag_req_modal:req1",
          state: { values: {} },
        },
      },
    ]) {
      expect(parseInteraction(payload, single.questions).ok).toBe(false);
    }
  });
});

const takeover = {
  ...base,
  publicBaseUrl: "https://hm.test/",
  reason: "Log in <please>",
  runId: "run1",
};

test("takeover card has a screen link and only cancellation control", () => {
  const card = takeoverCard(takeover);
  expect(card.text).toContain("Pilot: Log in &lt;please&gt;");
  const actions = card.blocks.find((block) => block.type === "actions");
  expect(actions?.elements).toEqual([
    {
      action_id: "ag_req:req1:screen",
      text: { text: "Open screen", type: "plain_text" },
      type: "button",
      url: "https://hm.test/tasks/run1#computer",
    },
    {
      action_id: "ag_req:req1:cancel",
      style: "danger",
      text: { text: "Cancel request", type: "plain_text" },
      type: "button",
    },
  ]);
  expect(parseInteraction(click(actions?.elements[1]))).toMatchObject({
    cancel: true,
    ok: true,
    requestId: "req1",
    userId: "U1",
  });
  expect(parseInteraction(click(actions?.elements[0])).ok).toBe(false);
  const preview = takeoverCard({ ...takeover, publicBaseUrl: "" });
  expect(JSON.stringify(preview)).not.toContain("Open screen");
  expect(JSON.stringify(preview)).toContain("Cancel request");
});

test("settled takeover cards show hand-back or cancellation without actions", () => {
  for (const outcome of [
    { answer: {}, status: "answered" },
    { status: "cancelled" },
  ] as const) {
    const card = settledCard(takeover, { by: "Dom", outcome, via: "web" });
    expect(card.text).toContain(
      outcome.status === "answered" ? "Handed back by Dom" : "Cancelled"
    );
    expect(card.blocks.some((block) => block.type === "actions")).toBe(false);
    expect(JSON.stringify(card.blocks)).toContain(
      outcome.status === "answered" ? "Handed back by Dom" : "Cancelled"
    );
    expect(JSON.stringify(card.blocks)).toContain("Log in &lt;please&gt;");
  }
});

const decisionsQueue = {
  ...base,
  answers: {},
  decisions: [
    { id: "d1", options: ["Yes", "No"], text: "Ship it?" },
    {
      freeText: true,
      id: "d2",
      options: ["Monday", "Friday"],
      text: "When?",
    },
  ],
};
const sectionTexts = (blocks: RequestCard["blocks"]): string[] =>
  blocks.flatMap((block) =>
    block.type === "section" ? [block.text.text] : []
  );
const actionIds = (blocks: RequestCard["blocks"]): string[][] =>
  blocks.flatMap((block) =>
    block.type === "actions"
      ? [block.elements.map((button) => button.action_id)]
      : []
  );

test("open decisions card has option buttons, a free-text hint and expiry", () => {
  const card = decisionsCard(decisionsQueue, { settled: false });
  expect(card.text).toBe("Pilot: Ship it?; When?");
  expect(sectionTexts(card.blocks)).toEqual([
    "*Pilot* has 2 decisions to make",
    "*1.* Ship it?",
    "*2.* When?\n_You can also type your own answer in Agentum._",
    `Expires <!date^1800000000^{date_short_pretty} at {time}|${new Date(base.expiresAt).toISOString()}>`,
  ]);
  expect(actionIds(card.blocks)).toEqual([
    ["ag_req:req1:decide:0:0", "ag_req:req1:decide:0:1"],
    ["ag_req:req1:decide:1:0", "ag_req:req1:decide:1:1"],
  ]);
  expect(card.blocks.at(-1)?.type).toBe("section");
});

test("an answered decision shows its answer and only open ones keep buttons", () => {
  const card = decisionsCard(
    { ...decisionsQueue, answers: { d1: "Yes" } },
    { settled: false }
  );
  expect(sectionTexts(card.blocks).slice(1, 3)).toEqual([
    "*1.* Ship it?\nAnswer: Yes",
    "*2.* When?\n_You can also type your own answer in Agentum._",
  ]);
  expect(actionIds(card.blocks)).toEqual([
    ["ag_req:req1:decide:1:0", "ag_req:req1:decide:1:1"],
  ]);
});

test("settled answered decisions show Answered and no buttons", () => {
  const answered = {
    ...decisionsQueue,
    answers: { d1: "Yes", d2: "Friday" },
  };
  const card = settledCard(answered, {
    by: "Dom",
    outcome: {
      answer: { decisions: { d1: "Yes", d2: "Friday" } },
      status: "answered",
    },
    via: "web",
  });
  expect(card.blocks.some((block) => block.type === "actions")).toBe(false);
  expect(card.text).toContain("Answered by Dom on the web");
  expect(sectionTexts(card.blocks)).toContain("*1.* Ship it?\nAnswer: Yes");
  expect(sectionTexts(card.blocks)).toContain("*2.* When?\nAnswer: Friday");
});

test("expired decisions mark the unanswered one and say nobody answered", () => {
  const card = settledCard(
    { ...decisionsQueue, answers: { d1: "Yes" } },
    { outcome: { status: "expired" } }
  );
  expect(card.blocks.some((block) => block.type === "actions")).toBe(false);
  expect(sectionTexts(card.blocks)).toContain("*2.* When?\n_No answer_");
  expect(card.text).toContain("Expired, nobody answered");
});

test("a decision click answers keyed by the decision id", () => {
  const card = decisionsCard(decisionsQueue, { settled: false });
  const [, second] = card.blocks.filter((block) => block.type === "actions");
  expect(
    parseInteraction(
      click(second?.elements[1]),
      undefined,
      decisionsQueue.decisions
    )
  ).toEqual({
    answer: { decisions: { d2: "Friday" } },
    appId: "A1",
    ok: true,
    requestId: "req1",
    teamId: "T1",
    userId: "U1",
  });
  expect(parseInteraction(click(second?.elements[1]))).toEqual({
    ok: false,
    reason: "questions_required",
    requestId: "req1",
  });
  expect(
    parseInteraction(
      click({ action_id: "ag_req:req1:decide:0:9" }),
      undefined,
      decisionsQueue.decisions
    )
  ).toEqual({ ok: false, reason: "invalid", requestId: "req1" });
  expect(
    parseInteraction(
      click({ action_id: "ag_req:req1:decide:5:0" }),
      undefined,
      decisionsQueue.decisions
    )
  ).toEqual({ ok: false, reason: "invalid", requestId: "req1" });
});
