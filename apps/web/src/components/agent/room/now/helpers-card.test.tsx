/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects and promises. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderInRoom } from "../test-fixtures.tsx";
import { HelpersCard } from "./helpers-card.tsx";
import { makeTask } from "./now-fixtures.ts";
import { liveHelpers } from "./now-logic.ts";

const noop = (_runId: string): void => undefined;

const CHIP_MARKER = 'data-testid="helper-chip"';

/** The markup of each chip, in order, cut at the next chip. */
const chipsOf = (markup: string): string[] =>
  markup.split(CHIP_MARKER).slice(1);

test("each live helper is a chip with its link, model and Stop button", () => {
  const markup = renderInRoom(
    <HelpersCard
      busyId={null}
      helpers={liveHelpers(makeTask())}
      onStop={noop}
    />
  );
  const chips = chipsOf(markup);
  expect(chips).toHaveLength(2);
  expect(markup).toContain("Read the bank export");
  expect(markup).toContain("Draft the reminders");
  expect(markup).toContain('href="/tasks/run_2"');
  expect(markup).toContain('href="/tasks/run_3"');
  expect(markup).toContain('aria-label="Stop Read the bank export"');
  expect(markup).toContain('aria-label="Stop Draft the reminders"');
  expect(markup).not.toContain("Count the receipts");
});

test("an empty helper list renders nothing", () => {
  expect(
    renderInRoom(<HelpersCard busyId={null} helpers={[]} onStop={noop} />)
  ).toBe("");
});

test("only the chip whose Stop is in flight is disabled and reads Stopping", () => {
  const markup = renderInRoom(
    <HelpersCard
      busyId="run_3"
      helpers={liveHelpers(makeTask())}
      onStop={noop}
    />
  );
  const [first, second] = chipsOf(markup);
  expect(first).not.toContain('disabled=""');
  expect(first).toContain("Stop</button>");
  expect(second).toContain('disabled=""');
  expect(second).toContain("Stopping…");
});

const dom = new Window({ url: "https://preview.agentum.test" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const globalKeys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "Event",
  "MouseEvent",
  "HTMLButtonElement",
  "IS_REACT_ACT_ENVIRONMENT",
];

beforeAll(() => {
  for (const key of globalKeys) {
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

/** Mounts the element in a router and a DOM container, the way the room renders it in the browser. */
const mountInRouter = async (element: ReactElement) => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <RouterContextProvider router={router}>{element}</RouterContextProvider>
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

const buttonNamed = (
  container: HTMLElement,
  label: string
): HTMLButtonElement => {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`the ${label} button is missing`);
  }
  return button;
};

test("clicking Stop calls onStop with that helper's run id", async () => {
  const onStop = mock((_runId: string) => undefined);
  const { container, unmount } = await mountInRouter(
    <HelpersCard
      busyId={null}
      helpers={liveHelpers(makeTask())}
      onStop={onStop}
    />
  );
  try {
    await act(async () =>
      buttonNamed(container, "Stop Draft the reminders").click()
    );
    expect(onStop).toHaveBeenCalledWith("run_3");
    expect(onStop).toHaveBeenCalledTimes(1);
  } finally {
    await unmount();
  }
});
