/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { Window } from "happy-dom";
import { act } from "react";

const dom = new Window({ url: "http://localhost" });
const previous = new Map<string, PropertyDescriptor | undefined>();
for (const key of [
  "Event",
  "CustomEvent",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "NodeFilter",
  "DOMRect",
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "MutationObserver",
  "localStorage",
  "Node",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "IS_REACT_ACT_ENVIRONMENT",
]) {
  previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
  });
}

const { AssistantRuntimeProvider, useExternalStoreRuntime } = await import(
  "@assistant-ui/react"
);
const { createRoot } = await import("react-dom/client");
const { BottomBar } = await import("./bottom-bar.tsx");
const { ComposerContainer } = await import("./composer-container.tsx");
const { busyNote } = await import("./thread-send.ts");
const { TooltipProvider } = await import("#/components/ui/tooltip");

afterAll(() => {
  for (const [key, value] of previous) {
    if (value) {
      Object.defineProperty(globalThis, key, value);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }
});

const noop = () => undefined;
const done = () => Promise.resolve();

beforeAll(() => {
  Object.defineProperty(dom, "visualViewport", {
    configurable: true,
    value: null,
  });
});

function WorkingThread({
  runtime,
  replyBelow = true,
}: {
  runtime: "cloud" | "machine";
  replyBelow?: boolean;
}) {
  const store = useExternalStoreRuntime<ThreadMessageLike>({
    convertMessage: (message) => message,
    messages: [],
    onNew: done,
  });
  return (
    <TooltipProvider>
      <AssistantRuntimeProvider runtime={store}>
        <BottomBar
          atBottom
          canStop
          onLatest={noop}
          onReview={noop}
          onStop={noop}
          origin="ui"
          pending={null}
          replyBelow={replyBelow}
          requestVisible
          runNumber={3}
          state="working"
          stopping={false}
          typing={false}
        />
        <ComposerContainer busyNote={busyNote(runtime)} disabledNote={null} />
      </AssistantRuntimeProvider>
    </TooltipProvider>
  );
}

const render = async (props: Parameters<typeof WorkingThread>[0]) => {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(<WorkingThread {...props} />);
  });
  return { host, unmount: () => act(async () => root.unmount()) };
};

test("the reply box stays open while a Cloud task works, and says the agent reads it as it works", async () => {
  const { host, unmount } = await render({ runtime: "cloud" });
  const box = host.querySelector("textarea");
  expect(box).not.toBeNull();
  expect(box?.hasAttribute("disabled")).toBe(false);
  expect(host.textContent).toContain("Task 3 is working.");
  expect(host.textContent).not.toContain("Reply when it is done.");
  expect(host.querySelector('[data-testid="busy-note"]')?.textContent).toBe(
    "The agent reads this as it works."
  );
  expect(host.textContent).not.toContain("Sending starts task");
  await unmount();
});

test("another runtime's box says the agent gets the message when the step ends", async () => {
  const { host, unmount } = await render({ runtime: "machine" });
  expect(host.querySelector("textarea")).not.toBeNull();
  expect(host.querySelector('[data-testid="busy-note"]')?.textContent).toBe(
    "The agent gets this when the current step ends."
  );
  await unmount();
});

test("without a reply box under it, the working strip still tells the person to wait", async () => {
  const { host, unmount } = await render({
    replyBelow: false,
    runtime: "machine",
  });
  expect(host.textContent).toContain("Reply when it is done.");
  await unmount();
});
