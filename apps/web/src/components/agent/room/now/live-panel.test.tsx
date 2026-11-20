/** biome-ignore-all lint/suspicious/useAwait: Async act flushes effects and promises. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import { fixtureRoom } from "../test-fixtures.tsx";
import { makeListItem, makeTask } from "./now-fixtures.ts";

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

const NOW_ISO = new Date().toISOString();
// The helper started after its parent, so it is the newest row, as it is in a real list.
const listed = [
  makeListItem({
    createdAt: NOW_ISO,
    helper: true,
    id: "run_3",
    title: "Draft the reminders",
  }),
  makeListItem({ createdAt: NOW_ISO, id: "run_1" }),
];

const list = mock((_input: unknown) => Promise.resolve(listed));
const get = mock((_input: unknown) => Promise.resolve(makeTask()));
const cancel = mock((_input: unknown) => Promise.resolve({}));
const files = mock((_input: unknown) =>
  Promise.resolve({
    conflicts: [],
    entries: [
      {
        etag: "e",
        kind: "file",
        mtime: NOW_ISO,
        path: "agents/sorter/tasks/run_1/report.md",
        size: 1200,
        updatedBy: { id: "agent_1", kind: "agent" },
      },
    ],
    folder: "agents/sorter/tasks/run_1",
    outside: [],
  })
);
const artifacts = mock((_input: unknown) => Promise.resolve({ items: [] }));

beforeAll(() => {
  for (const key of globalKeys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  mock.module("#/integrations/trpc/client", () => ({
    getTrpc: () => ({
      artifacts: { list: { query: artifacts } },
      memory: {
        changes: { query: () => Promise.resolve([]) },
        list: { query: () => Promise.resolve([]) },
        rules: {
          get: {
            query: () => Promise.resolve({ agent: { learnLevel: "ask" } }),
          },
        },
      },
      runs: { cancel: { mutate: cancel } },
      tasks: {
        files: { query: files },
        get: { query: get },
        list: { query: list },
      },
    }),
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

test("the panel follows the parent task, not its helper, and Stop cancels the helper", async () => {
  const { NowPanel } = await import("./index.tsx");
  const room = fixtureRoom();
  room.tasks = listed;
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <RouterContextProvider router={router}>
        <NowPanel nowMs={Date.now()} room={room} />
      </RouterContextProvider>
    )
  );
  try {
    const text = container.textContent ?? "";
    expect(text).toContain("Reconcile the invoices");
    expect(text).toContain("Search invoices");
    expect(get).toHaveBeenCalledWith({ runId: "run_1" });
    expect(
      container.querySelectorAll('[data-testid="helper-chip"]')
    ).toHaveLength(2);
    expect(text).toContain("report.md");

    const stop = container.querySelector(
      'button[aria-label="Stop Draft the reminders"]'
    );
    if (!(stop instanceof HTMLButtonElement)) {
      throw new Error("the Stop button is missing");
    }
    const listCalls = list.mock.calls.length;
    await act(async () => stop.click());
    expect(cancel).toHaveBeenCalledWith({ runId: "run_3" });
    expect(list.mock.calls.length).toBeGreaterThan(listCalls);
  } finally {
    await act(async () => {
      root.unmount();
      container.remove();
    });
  }
});
