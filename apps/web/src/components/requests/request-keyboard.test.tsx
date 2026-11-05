/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects. */
import { expect, test } from "bun:test";
import { type HTMLButtonElement, Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { focusRequest } from "../task/task-behaviour.ts";
import { QuestionCard, TakeoverCard } from "./request-card.tsx";
import type { AnswerPayload, RequestView } from "./request-card-logic.ts";

const noop = () => undefined;

test("question starts empty, radio arrows choose, and Ctrl+Enter sends", async () => {
  const dom = new Window();
  const keys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ];
  const previous = new Map(
    keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const key of keys) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  const answers: AnswerPayload[] = [];
  const answer = (_view: RequestView, payload: AnswerPayload) => {
    answers.push(payload);
    return Promise.resolve();
  };
  const view: Extract<RequestView, { kind: "question" }> = {
    anchorId: null,
    display: { questions: [{ choices: ["A", "B"], question: "Which?" }] },
    expiresAt: "2030-01-01T00:00:00Z",
    id: "req",
    kind: "question",
    runId: "run",
    settled: null,
  };
  try {
    await act(async () =>
      root.render(
        <div id="thread-request-req">
          <QuestionCard nowMs={0} onAnswer={answer} view={view} />
        </div>
      )
    );
    const radios =
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    const send = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Send answer"
    );
    expect(send?.disabled).toBe(true);
    expect(radios[0]?.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      radios[0]?.focus();
      radios[0]?.dispatchEvent(
        new dom.KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })
      );
    });
    expect(dom.document.activeElement === radios[1]).toBe(true);
    expect(radios[1]?.getAttribute("aria-checked")).toBe("true");
    expect(send?.disabled).toBe(false);
    const input = container.querySelector("input");
    await act(async () => input?.focus());
    await act(async () =>
      input?.dispatchEvent(
        new dom.KeyboardEvent("keydown", {
          bubbles: true,
          ctrlKey: true,
          key: "Enter",
        })
      )
    );
    expect(answers).toEqual([{ answers: { "Which?": "B" } }]);
    focusRequest("req");
    expect(
      dom.document.activeElement?.hasAttribute("data-request-heading")
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    for (const key of keys) {
      const value = previous.get(key);
      if (value) {
        Object.defineProperty(globalThis, key, value);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }
    await dom.happyDOM.close();
  }
});

test("takeover action lives on the request; holding control replaces it with cyan status", () => {
  const view: Extract<RequestView, { kind: "takeover" }> = {
    anchorId: null,
    display: { machineId: "machine", reason: "Sign in" },
    expiresAt: "2030-01-01T00:00:00Z",
    id: "r",
    kind: "takeover",
    runId: "run",
    settled: null,
  };
  const waiting = renderToStaticMarkup(
    <TakeoverCard canTake={true} nowMs={0} onComputer={noop} view={view} />
  );
  expect(waiting).toContain(">Take over</button>");
  expect(waiting).toContain("Cancel request");
  const control = renderToStaticMarkup(
    <TakeoverCard inControl={true} nowMs={0} view={view} />
  );
  expect(control).toContain("You have control");
  expect(control).toContain("bg-info/10");
  expect(control).not.toContain("button");
});
