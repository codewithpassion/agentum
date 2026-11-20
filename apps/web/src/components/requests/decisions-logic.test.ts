import { expect, test } from "bun:test";
import type { DecisionsDisplay } from "@repo/protocol/requests";
import {
  answeredCount,
  type DecisionInputs,
  EMPTY_DECISION_INPUTS,
  pickDecision,
  pressedOption,
  progressText,
  stagedDecisions,
  typeDecision,
} from "./decisions-logic.ts";

const display: DecisionsDisplay = {
  questions: [
    { id: "deploy", options: ["Yes", "No"], text: "Deploy?" },
    { freeText: true, id: "region", options: ["EU", "US"], text: "Region?" },
    { id: "tone", options: ["Formal", "Casual"], text: "Tone?" },
  ],
};

test("picking an option selects it, picking it again clears it, and another option replaces it", () => {
  const first = pickDecision(EMPTY_DECISION_INPUTS, "deploy", "Yes");
  expect(first.picked).toEqual({ deploy: "Yes" });
  const replaced = pickDecision(first, "deploy", "No");
  expect(replaced.picked).toEqual({ deploy: "No" });
  const cleared = pickDecision(replaced, "deploy", "No");
  expect(cleared.picked).toEqual({});
});

test("picking leaves other questions alone and does not mutate its input", () => {
  const before: DecisionInputs = { picked: { tone: "Formal" }, typed: {} };
  const after = pickDecision(before, "deploy", "Yes");
  expect(after.picked).toEqual({ deploy: "Yes", tone: "Formal" });
  expect(before.picked).toEqual({ tone: "Formal" });
});

test("typing sets the text and clears the pick for that question only", () => {
  const picked = pickDecision(EMPTY_DECISION_INPUTS, "region", "EU");
  const typed = typeDecision(picked, "region", "Asia");
  expect(typed.typed).toEqual({ region: "Asia" });
  expect(typed.picked).toEqual({});
  const withOther = typeDecision(
    pickDecision(typed, "deploy", "No"),
    "region",
    "Asia"
  );
  expect(withOther.picked).toEqual({ deploy: "No" });
});

test("picking an option clears typed text for that question", () => {
  const typed = typeDecision(EMPTY_DECISION_INPUTS, "region", "Asia");
  const picked = pickDecision(typed, "region", "US");
  expect(picked.typed).toEqual({});
  expect(picked.picked).toEqual({ region: "US" });
});

test("stagedDecisions sends picks and trimmed typed text, and leaves out empty and saved answers", () => {
  const inputs: DecisionInputs = {
    picked: { deploy: "Yes", tone: "Formal" },
    typed: { region: "  Asia  " },
  };
  const given = { tone: "Formal" };
  expect(stagedDecisions(display, given, inputs)).toEqual({
    deploy: "Yes",
    region: "Asia",
  });
});

test("stagedDecisions leaves out a question whose typed text is blank", () => {
  const inputs = typeDecision(EMPTY_DECISION_INPUTS, "region", "   ");
  expect(stagedDecisions(display, {}, inputs)).toEqual({});
});

test("stagedDecisions ignores typed text on a question without freeText", () => {
  const inputs: DecisionInputs = {
    picked: {},
    typed: { deploy: "Maybe later" },
  };
  expect(stagedDecisions(display, {}, inputs)).toEqual({});
});

test("stagedDecisions sends a changed answer over a saved one", () => {
  const inputs = pickDecision(EMPTY_DECISION_INPUTS, "deploy", "No");
  expect(stagedDecisions(display, { deploy: "Yes" }, inputs)).toEqual({
    deploy: "No",
  });
});

test("answeredCount counts saved and staged answers once each", () => {
  const inputs = pickDecision(EMPTY_DECISION_INPUTS, "tone", "Casual");
  expect(answeredCount(display, { deploy: "Yes" }, EMPTY_DECISION_INPUTS)).toBe(
    1
  );
  expect(answeredCount(display, { deploy: "Yes" }, inputs)).toBe(2);
  expect(
    answeredCount(display, { deploy: "Yes", tone: "Formal" }, inputs)
  ).toBe(2);
});

test("answeredCount does not count a blank typed answer", () => {
  const inputs = typeDecision(EMPTY_DECISION_INPUTS, "region", " ");
  expect(answeredCount(display, {}, inputs)).toBe(0);
});

test("pressedOption shows a pick, then a saved answer, and no option while text is typed", () => {
  expect(pressedOption("Yes", EMPTY_DECISION_INPUTS, "deploy")).toBe("Yes");
  const picked = pickDecision(EMPTY_DECISION_INPUTS, "deploy", "No");
  expect(pressedOption("Yes", picked, "deploy")).toBe("No");
  const typed = typeDecision(EMPTY_DECISION_INPUTS, "deploy", "Later");
  expect(pressedOption("Yes", typed, "deploy")).toBeUndefined();
  expect(
    pressedOption(undefined, EMPTY_DECISION_INPUTS, "deploy")
  ).toBeUndefined();
});

test("progressText reads n of total answered", () => {
  expect(progressText(1, 3)).toBe("1 of 3 answered");
  expect(progressText(0, 2)).toBe("0 of 2 answered");
});
