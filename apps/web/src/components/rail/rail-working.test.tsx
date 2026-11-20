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
import { renderToStaticMarkup } from "react-dom/server";
import { WorkingList } from "./rail-working.tsx";

const noop = () => undefined;
const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>{node}</RouterContextProvider>
  );

const someRuns = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    agentId: "a",
    agentName: "Agent",
    id: String(i),
    mine: true,
    passedOnBy: null,
    status: "Running",
    title: `Task ${i}`,
  }));

test("Working caps at three and links to the conversation list filtered to running", () => {
  const html = render(<WorkingList onNavigate={noop} runs={someRuns(5)} />);
  expect(html).toContain("Task 2");
  expect(html).not.toContain("Task 3");
  expect(html).toContain("View all 5 running");
  expect(html).toContain('href="/sessions?working=true"');
  expect(render(<WorkingList onNavigate={noop} runs={[]} />)).toBe("");
});

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

test("Working expands to show only three runs", async () => {
  const container = document.createElement("div");
  const root = createRoot(container as unknown as Element);
  const runs = someRuns(5);
  try {
    await act(async () =>
      root.render(
        <RouterContextProvider router={router}>
          <WorkingList onNavigate={noop} runs={runs} />
        </RouterContextProvider>
      )
    );
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
