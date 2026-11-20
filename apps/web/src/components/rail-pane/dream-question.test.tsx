import { expect, test } from "bun:test";
import type { DreamNeedsYou } from "@repo/db/shared";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DreamQuestionBody } from "./dream-question.tsx";

type Answer = (questionId: string, noteId: string) => Promise<void>;
type TestDocument = Window["document"];

interface Mounted {
  document: TestDocument;
  unmount: () => Promise<void>;
}

const noop: Answer = async () => undefined;

const twoOptions: DreamNeedsYou = {
  options: [
    { noteId: "note_a", text: "Works Mondays" },
    { noteId: "note_b", text: "Works Tuesdays" },
  ],
  question: "Which day does Ada work?",
  questionId: "q1",
};

const threeOptions: DreamNeedsYou = {
  ...twoOptions,
  options: [...twoOptions.options, { noteId: "note_c", text: "Works Fridays" }],
};

const mountBody = async (
  dream: DreamNeedsYou,
  onAnswer: Answer
): Promise<Mounted> => {
  const dom = new Window({ url: "http://localhost/" });
  const previous = {
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as Record<string, unknown>)
      .IS_REACT_ACT_ENVIRONMENT,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom,
  });
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(<DreamQuestionBody dream={dream} onAnswer={onAnswer} />)
  );
  return {
    document: dom.document,
    unmount: async () => {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous);
    },
  };
};

const optionButtons = (document: TestDocument) =>
  Array.from(document.querySelectorAll("button")).filter(
    (button) => button.closest('[data-testid="dream-option"]') !== null
  );

test("two options render their notes, one Keep button each, and the two-note line", async () => {
  const mounted = await mountBody(twoOptions, noop);
  try {
    const body = mounted.document.querySelector(
      '[data-testid="dream-question-body"]'
    );
    const options = mounted.document.querySelectorAll(
      '[data-testid="dream-option"]'
    );
    expect(body?.textContent).toContain("Which day does Ada work?");
    expect(body?.textContent).toContain(
      "These two notes disagree. Keep the one that is right and the dream drops the other."
    );
    expect(options.length).toBe(2);
    expect(options[0]?.textContent).toContain("Works Mondays");
    expect(options[1]?.textContent).toContain("Works Tuesdays");
    expect(options[0]?.querySelectorAll("button").length).toBe(1);
    expect(options[1]?.querySelectorAll("button").length).toBe(1);
    expect(
      optionButtons(mounted.document).map((button) => button.textContent)
    ).toEqual(["Keep this one", "Keep this one"]);
  } finally {
    await mounted.unmount();
  }
});

test("three options render three rows and the general line", async () => {
  const mounted = await mountBody(threeOptions, noop);
  try {
    const body = mounted.document.querySelector(
      '[data-testid="dream-question-body"]'
    );
    expect(
      mounted.document.querySelectorAll('[data-testid="dream-option"]').length
    ).toBe(3);
    expect(optionButtons(mounted.document).length).toBe(3);
    expect(body?.textContent).toContain(
      "These notes disagree. Keep the one that is right and the dream drops the others."
    );
    expect(body?.textContent).not.toContain("These two notes");
  } finally {
    await mounted.unmount();
  }
});

test("Keep this one on the second option answers with the question and that note", async () => {
  const answers: [string, string][] = [];
  const onAnswer: Answer = (questionId, noteId) => {
    answers.push([questionId, noteId]);
    return Promise.resolve();
  };
  const mounted = await mountBody(twoOptions, onAnswer);
  try {
    await act(async () => optionButtons(mounted.document)[1]?.click());
    expect(answers).toEqual([["q1", "note_b"]]);
  } finally {
    await mounted.unmount();
  }
});

test("every button is disabled while an answer runs, and they come back after it", async () => {
  let release: () => void = () => undefined;
  const onAnswer: Answer = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const mounted = await mountBody(twoOptions, onAnswer);
  try {
    await act(async () => optionButtons(mounted.document)[0]?.click());
    expect(
      optionButtons(mounted.document).map((button) => button.disabled)
    ).toEqual([true, true]);
    await act(async () => release());
    expect(
      optionButtons(mounted.document).map((button) => button.disabled)
    ).toEqual([false, false]);
  } finally {
    await mounted.unmount();
  }
});

test("a rejected answer shows its reason as an alert and re-enables the buttons", async () => {
  const onAnswer: Answer = () =>
    Promise.reject(new Error("That note was already forgotten."));
  const mounted = await mountBody(twoOptions, onAnswer);
  try {
    await act(async () => optionButtons(mounted.document)[0]?.click());
    const alert = mounted.document.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("That note was already forgotten.");
    expect(
      optionButtons(mounted.document).map((button) => button.disabled)
    ).toEqual([false, false]);
  } finally {
    await mounted.unmount();
  }
});
