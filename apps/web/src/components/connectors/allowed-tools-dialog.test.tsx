/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects and promises. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
// biome-ignore lint/performance/noNamespaceImport: spyOn needs the module object.
import * as dialog from "#/components/ui/dialog";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import { AllowedToolsDialog } from "./allowed-tools-dialog.tsx";

const dom = new Window({ url: "https://preview.agentum.test" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
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

const spies: { mockRestore: () => void }[] = [];
const assign = mock((_input: unknown) => Promise.resolve({}));
const noop = (): void => undefined;
const CLEAR_LIST = "Clear list";
const ALLOW_EVERY_TOOL = "Allow every tool";

beforeAll(() => {
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  // Radix caches whether a DOM exists at import time, so its portal would render nothing here.
  spies.push(
    spyOn(dialog, "DialogContent").mockImplementation(({ children }) => (
      <div>{children}</div>
    ))
  );
  mock.module("#/integrations/trpc/client", () => ({
    getTrpc: () => ({ connectors: { assign: { mutate: assign } } }),
  }));
});

afterAll(() => {
  for (const spy of spies) {
    spy.mockRestore();
  }
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
  assign.mockClear();
});

const buttonNamed = (label: string): HTMLButtonElement => {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) =>
      candidate.textContent === label ||
      candidate.getAttribute("aria-label") === label
  );
  if (button === undefined) {
    throw new Error(`the ${label} button is missing`);
  }
  return button as HTMLButtonElement;
};

const hasButton = (label: string): boolean =>
  [...document.body.querySelectorAll("button")].some(
    (candidate) => candidate.textContent === label
  );

const renderDialog = async (allowedTools: string[] | null) => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <AllowedToolsDialog
        agentId="agent_1"
        allowedTools={allowedTools}
        connector={{ id: "conn_gmail", name: "Gmail", tools: [] }}
        credentialMode="user_or_agent"
        onClose={noop}
        onSaved={noop}
      />
    )
  );
  return {
    unmount: () =>
      act(async () => {
        root.unmount();
        container.remove();
      }),
  };
};

test("with an empty cache the saved names are listed, and removing one saves the rest", async () => {
  const { unmount } = await renderDialog(["search_threads", "get_thread"]);
  try {
    expect(document.body.textContent).toContain("search_threads");
    expect(document.body.textContent).toContain("get_thread");
    expect(hasButton(CLEAR_LIST)).toBe(false);
    expect(buttonNamed("Save").disabled).toBe(true);
    await act(async () => buttonNamed("Remove get_thread").click());
    expect(document.body.textContent).not.toContain("get_thread");
    await act(async () => buttonNamed("Save").click());
    expect(assign).toHaveBeenCalledWith({
      agentId: "agent_1",
      allowedTools: ["search_threads"],
      connectorId: "conn_gmail",
      credentialMode: "user_or_agent",
    });
  } finally {
    await unmount();
  }
});

test("removing every saved name says so and the button no longer reads Save", async () => {
  const { unmount } = await renderDialog(["search_threads"]);
  try {
    await act(async () => buttonNamed("Remove search_threads").click());
    expect(document.body.textContent).toContain(
      "No names left. Saving allows every tool."
    );
    expect(hasButton("Save")).toBe(false);
    await act(async () => buttonNamed(ALLOW_EVERY_TOOL).click());
    expect(assign).toHaveBeenCalledWith({
      agentId: "agent_1",
      allowedTools: [],
      connectorId: "conn_gmail",
      credentialMode: "user_or_agent",
    });
  } finally {
    await unmount();
  }
});

test("with an empty cache and no saved names only Clear list is offered", async () => {
  const { unmount } = await renderDialog(null);
  try {
    expect(document.body.textContent).toContain("no cached tool list");
    expect(hasButton(CLEAR_LIST)).toBe(true);
    expect(hasButton("Save")).toBe(false);
  } finally {
    await unmount();
  }
});
