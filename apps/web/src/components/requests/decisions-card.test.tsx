/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects. */
import { expect, test } from "bun:test";
import type { DecisionsDisplay } from "@repo/protocol/requests";
import {
  type HTMLButtonElement,
  type HTMLInputElement,
  Window,
} from "happy-dom";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { DecisionsCard } from "./decisions-card.tsx";
import type { RequestView } from "./request-card-logic.ts";

type DecisionsView = Extract<RequestView, { kind: "decisions" }>;

const GLOBAL_KEYS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];

const display: DecisionsDisplay = {
  questions: [
    { id: "deploy", options: ["Yes", "No"], text: "Deploy?" },
    { freeText: true, id: "region", options: ["EU", "US"], text: "Region?" },
    { id: "tone", options: ["Formal", "Casual"], text: "Tone?" },
  ],
};

const viewWith = (given: Record<string, string>): DecisionsView => ({
  anchorId: null,
  display,
  expiresAt: "2030-01-01T00:00:00Z",
  given,
  id: "req",
  kind: "decisions",
  runId: "run",
  settled: null,
});

const noopAsync = () => Promise.resolve();
const neverSends = () => Promise.resolve({ complete: false, given: {} });

/** A happy-dom window with React's globals pointed at it, and the teardown that puts them back. */
async function mount() {
  const dom = new Window();
  const previous = new Map(
    GLOBAL_KEYS.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ])
  );
  for (const key of GLOBAL_KEYS) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container as unknown as Element);
  return {
    close: async () => {
      await act(async () => root.unmount());
      for (const key of GLOBAL_KEYS) {
        const value = previous.get(key);
        if (value) {
          Object.defineProperty(globalThis, key, value);
        } else {
          Reflect.deleteProperty(globalThis, key);
        }
      }
      await dom.happyDOM.close();
    },
    container,
    dom,
    render: (node: ReactNode) => act(async () => root.render(node)),
  };
}

type Harness = Awaited<ReturnType<typeof mount>>;

const buttonNamed = (
  harness: Harness,
  name: string
): HTMLButtonElement | undefined =>
  Array.from(
    harness.container.querySelectorAll<HTMLButtonElement>("button")
  ).find((button) => button.textContent === name);

const click = (harness: Harness, name: string) => {
  const button = buttonNamed(harness, name);
  if (button === undefined) {
    throw new Error(`No button named ${name}`);
  }
  return act(async () => {
    button.dispatchEvent(
      new harness.dom.MouseEvent("click", { bubbles: true })
    );
  });
};

const typeInto = (harness: Harness, label: string, text: string) => {
  const input = harness.container.querySelector<HTMLInputElement>(
    `input[aria-label="${label}"]`
  );
  if (input === null) {
    throw new Error(`No input labelled ${label}`);
  }
  const setValue = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value"
  )?.set;
  // React only reads a dispatched "input" when it sees a keyup or keydown on the
  // focused field here, so the change is sent with a keyup.
  return act(async () => {
    input.focus();
    setValue?.call(input, text);
    input.dispatchEvent(
      new harness.dom.KeyboardEvent("keyup", { bubbles: true, key: "a" })
    );
  });
};

const progress = (harness: Harness) =>
  harness.container.querySelector('[role="status"]')?.textContent;

const sendButton = (harness: Harness) => buttonNamed(harness, "Send answers");

const settledText = (harness: Harness) =>
  harness.container.querySelector('[data-testid="request-settled"]')
    ?.textContent;

test("partial answers: a send keeps the card open, merges what the server kept, and shows only the new staged pick", async () => {
  const harness = await mount();
  const sent: Record<string, string>[] = [];
  const onSend = (decisions: Record<string, string>) => {
    sent.push(decisions);
    return Promise.resolve({
      complete: false,
      given: { deploy: "Yes", region: "EU" },
    });
  };
  try {
    await harness.render(
      <DecisionsCard
        nowMs={0}
        onDismiss={noopAsync}
        onSend={onSend}
        view={viewWith({ deploy: "Yes" })}
      />
    );
    expect(progress(harness)).toBe("1 of 3 answered");
    expect(sendButton(harness)?.disabled).toBe(true);
    expect(buttonNamed(harness, "Yes")?.getAttribute("aria-pressed")).toBe(
      "true"
    );

    await click(harness, "EU");
    expect(progress(harness)).toBe("2 of 3 answered");
    expect(sendButton(harness)?.disabled).toBe(false);

    await click(harness, "Send answers");
    expect(sent).toEqual([{ region: "EU" }]);
    expect(
      harness.container.querySelector('[data-testid="request-card"]')
    ).not.toBeNull();
    expect(progress(harness)).toBe("2 of 3 answered");
    expect(buttonNamed(harness, "EU")?.getAttribute("aria-pressed")).toBe(
      "true"
    );
    expect(sendButton(harness)?.disabled).toBe(true);
  } finally {
    await harness.close();
  }
});

test("a send that completes the request shows All answered and closes the card", async () => {
  const harness = await mount();
  const sent: Record<string, string>[] = [];
  let closed = 0;
  const onClosed = () => {
    closed += 1;
  };
  const onSend = (decisions: Record<string, string>) => {
    sent.push(decisions);
    return Promise.resolve({
      complete: true,
      given: { deploy: "Yes", region: "EU", tone: "Formal" },
    });
  };
  try {
    await harness.render(
      <DecisionsCard
        nowMs={0}
        onClosed={onClosed}
        onDismiss={noopAsync}
        onSend={onSend}
        view={viewWith({ deploy: "Yes", region: "EU" })}
      />
    );
    await click(harness, "Formal");
    await click(harness, "Send answers");
    expect(sent).toEqual([{ tone: "Formal" }]);
    expect(settledText(harness)).toBe("All answered");
    expect(
      harness.container.querySelector('[data-testid="request-card"]')
    ).toBeNull();
    expect(closed).toBe(1);
  } finally {
    await harness.close();
  }
});

test("Dismiss calls onDismiss, shows Dismissed, and closes the card", async () => {
  const harness = await mount();
  let dismissed = 0;
  let closed = 0;
  const onDismiss = () => {
    dismissed += 1;
    return Promise.resolve();
  };
  const onClosed = () => {
    closed += 1;
  };
  try {
    await harness.render(
      <DecisionsCard
        nowMs={0}
        onClosed={onClosed}
        onDismiss={onDismiss}
        onSend={neverSends}
        view={viewWith({})}
      />
    );
    await click(harness, "Dismiss");
    expect(dismissed).toBe(1);
    expect(settledText(harness)).toBe("Dismissed");
    expect(closed).toBe(1);
  } finally {
    await harness.close();
  }
});

test("a rejected send shows its error and keeps the card editable", async () => {
  const harness = await mount();
  const onSend = () => Promise.reject(new Error("Boom"));
  try {
    await harness.render(
      <DecisionsCard
        nowMs={0}
        onDismiss={noopAsync}
        onSend={onSend}
        view={viewWith({})}
      />
    );
    await click(harness, "Yes");
    await click(harness, "Send answers");
    const alert = harness.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe("Boom");
    expect(
      harness.container.querySelector('[data-testid="request-card"]')
    ).not.toBeNull();
    expect(sendButton(harness)?.disabled).toBe(false);
    expect(buttonNamed(harness, "No")?.disabled).toBe(false);
    expect(buttonNamed(harness, "Yes")?.getAttribute("aria-pressed")).toBe(
      "true"
    );
  } finally {
    await harness.close();
  }
});

test("typed text on a free-text question is sent trimmed, and typing clears the pick", async () => {
  const harness = await mount();
  const sent: Record<string, string>[] = [];
  const onSend = (decisions: Record<string, string>) => {
    sent.push(decisions);
    return Promise.resolve({ complete: false, given: decisions });
  };
  try {
    await harness.render(
      <DecisionsCard
        nowMs={0}
        onDismiss={noopAsync}
        onSend={onSend}
        view={viewWith({})}
      />
    );
    await click(harness, "US");
    await typeInto(harness, "Your own answer to Region?", "  Asia  ");
    expect(buttonNamed(harness, "US")?.getAttribute("aria-pressed")).toBe(
      "false"
    );
    expect(progress(harness)).toBe("1 of 3 answered");
    await click(harness, "Send answers");
    expect(sent).toEqual([{ region: "Asia" }]);
  } finally {
    await harness.close();
  }
});
