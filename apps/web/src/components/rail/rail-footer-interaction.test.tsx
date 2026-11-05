/** biome-ignore-all lint/suspicious/useAwait: Async React act flushes queued effects. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { RailFooter } from "./rail-footer.tsx";
import { WorkingList } from "./rail-working.tsx";

const dom = new Window({ url: "http://localhost/" });
const previous = new Map<string, PropertyDescriptor | undefined>();
beforeAll(() => {
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ]) {
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

test("phone Find invokes the shell action, and Working expands only three runs", async () => {
  const container = document.createElement("div");
  const root = createRoot(container as unknown as Element);
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
  let finds = 0;
  const noop = () => undefined;
  const openFind = () => {
    finds += 1;
  };
  const runs = Array.from({ length: 5 }, (_, i) => ({
    agentId: "a",
    agentName: "Agent",
    id: String(i),
    mine: true,
    passedOnBy: null,
    status: "Running",
    title: `Run ${i}`,
  }));
  try {
    await act(async () =>
      root.render(
        <RouterContextProvider router={router}>
          <WorkingList onNavigate={noop} runs={runs} />
          <RailFooter admin isMobile onNavigate={noop} onOpenFind={openFind} />
        </RouterContextProvider>
      )
    );
    const find = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Find"
    );
    await act(async () => find?.click());
    expect(finds).toBe(1);
    const working = container.querySelector("button[aria-expanded]");
    expect(working?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => (working as unknown as HTMLButtonElement).click());
    expect(working?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll('a[href^="/tasks/"]')).toHaveLength(3);
    await act(async () => (working as unknown as HTMLButtonElement).click());
    expect(working?.getAttribute("aria-expanded")).toBe("false");
  } finally {
    await act(async () => root.unmount());
  }
});
