// The logic behind the decisions card: what a person has picked or typed but
// not sent, which questions count as answered, and the answers to send. Pure:
// `decisions-card.tsx` draws it and keeps the inputs.

import type { Decision, DecisionsDisplay } from "@repo/protocol/requests";

/** What a person picked or typed for each question, by question id. */
export interface DecisionInputs {
  picked: Readonly<Record<string, string>>;
  typed: Readonly<Record<string, string>>;
}

export const EMPTY_DECISION_INPUTS: DecisionInputs = { picked: {}, typed: {} };

const withoutKey = (
  record: Readonly<Record<string, string>>,
  key: string
): Record<string, string> =>
  Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));

/** Picks an option for a question, or clears the pick when it is the one already picked. Typed text for the question is cleared. */
export const pickDecision = (
  inputs: DecisionInputs,
  questionId: string,
  option: string
): DecisionInputs => ({
  picked:
    inputs.picked[questionId] === option
      ? withoutKey(inputs.picked, questionId)
      : { ...inputs.picked, [questionId]: option },
  typed: withoutKey(inputs.typed, questionId),
});

/** Sets the typed text for a question. A typed answer replaces the pick for that question. */
export const typeDecision = (
  inputs: DecisionInputs,
  questionId: string,
  text: string
): DecisionInputs => ({
  picked: withoutKey(inputs.picked, questionId),
  typed: { ...inputs.typed, [questionId]: text },
});

/** The answer a person has staged for one question: trimmed typed text when it is allowed and not empty, else the picked option, else "". */
const stagedAnswer = (question: Decision, inputs: DecisionInputs): string => {
  const typed = (inputs.typed[question.id] ?? "").trim();
  if (question.freeText === true && typed !== "") {
    return typed;
  }
  return inputs.picked[question.id] ?? "";
};

/**
 * The option a question shows as pressed. A pick shows as it is. With nothing
 * picked or typed, a saved answer shows. Typed text shows no option.
 */
export const pressedOption = (
  saved: string | undefined,
  inputs: DecisionInputs,
  questionId: string
): string | undefined => {
  const picked = inputs.picked[questionId];
  if (picked !== undefined) {
    return picked;
  }
  const typed = (inputs.typed[questionId] ?? "").trim();
  return typed === "" ? saved : undefined;
};

/** The answers to send: staged answers that are not empty and differ from the saved ones. */
export const stagedDecisions = (
  display: DecisionsDisplay,
  given: Readonly<Record<string, string>>,
  inputs: DecisionInputs
): Record<string, string> => {
  const staged: Record<string, string> = {};
  for (const question of display.questions) {
    const answer = stagedAnswer(question, inputs);
    if (answer !== "" && answer !== given[question.id]) {
      staged[question.id] = answer;
    }
  }
  return staged;
};

/** How many questions have a saved answer or a staged one. */
export const answeredCount = (
  display: DecisionsDisplay,
  given: Readonly<Record<string, string>>,
  inputs: DecisionInputs
): number =>
  display.questions.filter(
    (question) =>
      (given[question.id] ?? "") !== "" || stagedAnswer(question, inputs) !== ""
  ).length;

export const progressText = (answered: number, total: number): string =>
  `${answered} of ${total} answered`;
