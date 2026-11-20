/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects and promises. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MessageMenu } from "./message-menu.tsx";
import { type ThreadEnv, ThreadEnvProvider } from "./thread-context.tsx";

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
  "Event",
  "MouseEvent",
  "Node",
  "IS_REACT_ACT_ENVIRONMENT",
];

beforeAll(() => {
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
});

afterAll(() => {
  for (const [key, descriptor] of previous) {
    if (descriptor) {
      Object.defineProperty(globalThis, key, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

const baseEnv: ThreadEnv = {
  agentName: "Agent",
  answer: () => Promise.resolve(),
  editableId: null,
  edited: new Set(),
  files: new Map(),
  nowMs: null,
  requests: new Map(),
};

const renderMenu = async (env: ThreadEnv, text: string) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <ThreadEnvProvider value={env}>
        <MessageMenu text={text} />
      </ThreadEnvProvider>
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

const trigger = (container: HTMLElement) =>
  container.querySelector('[data-testid="message-menu"]');

test("without a remember target the menu renders nothing", async () => {
  const { container, unmount } = await renderMenu(baseEnv, "Keep this");
  try {
    expect(container.innerHTML).toBe("");
  } finally {
    await unmount();
  }
});

test("with a remember target the trigger renders", async () => {
  const { container, unmount } = await renderMenu(
    {
      ...baseEnv,
      remember: { agentId: "a1", sessionId: "s1" },
    },
    "Keep this"
  );
  try {
    expect(trigger(container)?.getAttribute("aria-label")).toBe(
      "Message actions"
    );
  } finally {
    await unmount();
  }
});

test("a message with blank text gets no menu", async () => {
  const { container, unmount } = await renderMenu(
    {
      ...baseEnv,
      remember: { agentId: "a1", sessionId: "s1" },
    },
    "   \n  "
  );
  try {
    expect(container.innerHTML).toBe("");
  } finally {
    await unmount();
  }
});
