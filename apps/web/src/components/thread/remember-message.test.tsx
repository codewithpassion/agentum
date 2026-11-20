/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects and promises. */
import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import {
  REMEMBER_KINDS,
  RememberForm,
  rememberDefaultText,
} from "./remember-message.tsx";

const dom = new Window({ url: "https://preview.agentum.test" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "getComputedStyle",
  "ResizeObserver",
  "MutationObserver",
  "CustomEvent",
  "KeyboardEvent",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLButtonElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "Event",
  "MouseEvent",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];

const add = mock((_input: unknown) => Promise.resolve({}));

beforeAll(() => {
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  mock.module("#/integrations/trpc/client", () => ({
    getTrpc: () => ({ memory: { add: { mutate: add } } }),
  }));
});

afterAll(() => {
  mock.module("#/integrations/trpc/client", () => ({ getTrpc: realGetTrpc }));
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

beforeEach(() => {
  add.mockClear();
});

const renderForm = async (
  messageText: string,
  callbacks: { onClose?: () => void; onSaved?: () => void } = {}
) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <RememberForm
        agentId="agent-1"
        messageText={messageText}
        onClose={callbacks.onClose ?? (() => undefined)}
        onSaved={callbacks.onSaved ?? (() => undefined)}
        sessionId="session-1"
      />
    )
  );
  return {
    container,
    unmount: () =>
      act(async () => {
        root.unmount();
        container.remove();
      }),
  };
};

const queryOne = <T extends Element>(
  container: HTMLElement,
  selector: string
) => {
  const element = container.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`missing ${selector}`);
  }
  return element;
};

const kindSelect = (container: HTMLElement): HTMLSelectElement => {
  const select = container.querySelector('[data-testid="remember-kind"]');
  if (!(select instanceof HTMLSelectElement)) {
    throw new Error("the Kind select is missing");
  }
  return select;
};

// happy-dom does not deliver `input` to React's onChange for a textarea. React's
// fallback reads a focused field on `keyup`, so typing is simulated that way.
const typeInto = async (textarea: HTMLTextAreaElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value"
  )?.set;
  textarea.focus();
  await act(async () => {
    setValue?.call(textarea, value);
    textarea.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
};

const chooseKind = (select: HTMLSelectElement, value: string) => {
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
};

const clickRemember = async (container: HTMLElement) => {
  const button = queryOne<HTMLButtonElement>(
    container,
    '[data-testid="remember-submit"]'
  );
  await act(async () => button.click());
};

test("the default text collapses whitespace runs, trims, and clips to 500 characters", () => {
  expect(rememberDefaultText("  one\n\ntwo \t three  ")).toBe("one two three");
  expect(rememberDefaultText("   \n  ")).toBe("");
  const clipped = rememberDefaultText(`${"a".repeat(499)} b c`);
  expect(clipped).toBe("a".repeat(499));
  expect(rememberDefaultText("x".repeat(600))).toHaveLength(500);
  expect(rememberDefaultText(`${"a".repeat(499)}😀`)).toBe("a".repeat(499));
});

test("the form shows the prefilled note and the four kinds", async () => {
  const { container, unmount } = await renderForm("  Call\n  Dana   back  ");
  try {
    const textarea = queryOne<HTMLTextAreaElement>(
      container,
      '[data-testid="remember-text"]'
    );
    expect(textarea.value).toBe("Call Dana back");
    const select = kindSelect(container);
    expect(select.value).toBe("work");
    const options = [...select.querySelectorAll("option")].map((option) => [
      option.value,
      option.textContent,
    ]);
    expect(options).toEqual([
      ["people", "People"],
      ["corrections", "Corrections"],
      ["work", "Work"],
      ["places", "Places"],
    ]);
    expect(REMEMBER_KINDS.map((kind) => kind.value)).toEqual([
      "people",
      "corrections",
      "work",
      "places",
    ]);
  } finally {
    await unmount();
  }
});

test("Remember sends the note with the agent, the session source and the default kind, once", async () => {
  const { container, unmount } = await renderForm("Dana is the client lead");
  try {
    await clickRemember(container);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith({
      agentId: "agent-1",
      kind: "work",
      source: { id: "session-1", kind: "session" },
      text: "Dana is the client lead",
    });
  } finally {
    await unmount();
  }
});

test("choosing another kind changes the kind sent", async () => {
  const { container, unmount } = await renderForm("Dana is the client lead");
  try {
    chooseKind(kindSelect(container), "places");
    await clickRemember(container);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "places" })
    );
  } finally {
    await unmount();
  }
});

test("an edited note is what gets sent, trimmed", async () => {
  const { container, unmount } = await renderForm("Original");
  try {
    await typeInto(
      queryOne<HTMLTextAreaElement>(container, '[data-testid="remember-text"]'),
      "  Edited note  "
    );
    await clickRemember(container);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Edited note" })
    );
  } finally {
    await unmount();
  }
});

test("onSaved and then onClose are called after a successful save", async () => {
  const calls: string[] = [];
  const { container, unmount } = await renderForm("Remember me", {
    onClose: () => calls.push("close"),
    onSaved: () => calls.push("saved"),
  });
  try {
    await clickRemember(container);
    expect(calls).toEqual(["saved", "close"]);
  } finally {
    await unmount();
  }
});

test("a rejected save shows the error and calls neither callback", async () => {
  add.mockImplementationOnce(() =>
    Promise.reject(new Error("The memory is full"))
  );
  const calls: string[] = [];
  const { container, unmount } = await renderForm("Remember me", {
    onClose: () => calls.push("close"),
    onSaved: () => calls.push("saved"),
  });
  try {
    await clickRemember(container);
    expect(queryOne(container, '[role="alert"]').textContent).toBe(
      "The memory is full"
    );
    expect(calls).toEqual([]);
  } finally {
    await unmount();
  }
});

test("Remember is disabled for blank text", async () => {
  const { container, unmount } = await renderForm("Something");
  try {
    const textarea = queryOne<HTMLTextAreaElement>(
      container,
      '[data-testid="remember-text"]'
    );
    const button = queryOne<HTMLButtonElement>(
      container,
      '[data-testid="remember-submit"]'
    );
    await typeInto(textarea, "   \n  ");
    expect(button.disabled).toBe(true);
    await typeInto(textarea, "Back again");
    expect(button.disabled).toBe(false);
  } finally {
    await unmount();
  }
});
