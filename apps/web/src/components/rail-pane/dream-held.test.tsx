import { expect, test } from "bun:test";
import type { DreamDecision } from "@repo/db/shared";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DreamHeldBody } from "./dream-held.tsx";

type Decide = (dreamRunId: string, decision: DreamDecision) => Promise<void>;
type TestDocument = Window["document"];

interface Mounted {
  document: TestDocument;
  unmount: () => Promise<void>;
}

const noop: Decide = async () => undefined;
const DREAM_RUN_ID = "dream_run_1";

const mountBody = async (onDecide: Decide): Promise<Mounted> => {
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
    root.render(
      <DreamHeldBody
        dreamHeld={{ dreamRunId: DREAM_RUN_ID }}
        onDecide={onDecide}
      />
    )
  );
  return {
    document: dom.document,
    unmount: async () => {
      await act(async () => root.unmount());
      Object.assign(globalThis, previous);
    },
  };
};

const decisionButton = (document: TestDocument, label: string) =>
  Array.from(document.querySelectorAll("button")).find(
    (button) => button.textContent === label
  );

// The body's own error line. The changes list inside the held batch can show
// its own alert when its load fails, so only a direct child counts here.
const bodyAlert = (document: TestDocument) =>
  document.querySelector('[data-testid="dream-held-body"] > [role="alert"]');

test("the body renders the held batch with Approve and Reject enabled", async () => {
  const mounted = await mountBody(noop);
  try {
    const body = mounted.document.querySelector(
      '[data-testid="dream-held-body"]'
    );
    expect(body?.querySelector('[data-testid="held-batch"]')).not.toBeNull();
    expect(decisionButton(mounted.document, "Approve")?.disabled).toBe(false);
    expect(decisionButton(mounted.document, "Reject")?.disabled).toBe(false);
    expect(bodyAlert(mounted.document)).toBeNull();
  } finally {
    await mounted.unmount();
  }
});

test("Approve sends the dream run id with approve", async () => {
  const calls: [string, DreamDecision][] = [];
  const onDecide: Decide = (dreamRunId, decision) => {
    calls.push([dreamRunId, decision]);
    return Promise.resolve();
  };
  const mounted = await mountBody(onDecide);
  try {
    await act(async () => decisionButton(mounted.document, "Approve")?.click());
    expect(calls).toEqual([[DREAM_RUN_ID, "approve"]]);
  } finally {
    await mounted.unmount();
  }
});

test("Reject sends the dream run id with reject", async () => {
  const calls: [string, DreamDecision][] = [];
  const onDecide: Decide = (dreamRunId, decision) => {
    calls.push([dreamRunId, decision]);
    return Promise.resolve();
  };
  const mounted = await mountBody(onDecide);
  try {
    await act(async () => decisionButton(mounted.document, "Reject")?.click());
    expect(calls).toEqual([[DREAM_RUN_ID, "reject"]]);
  } finally {
    await mounted.unmount();
  }
});

test("a rejected decision shows its reason as an alert and re-enables the buttons", async () => {
  const onDecide: Decide = () =>
    Promise.reject(new Error("Memory changed since this dream ran"));
  const mounted = await mountBody(onDecide);
  try {
    await act(async () => decisionButton(mounted.document, "Approve")?.click());
    expect(bodyAlert(mounted.document)?.textContent).toBe(
      "Memory changed since this dream ran"
    );
    expect(decisionButton(mounted.document, "Approve")?.disabled).toBe(false);
    expect(decisionButton(mounted.document, "Reject")?.disabled).toBe(false);
  } finally {
    await mounted.unmount();
  }
});
