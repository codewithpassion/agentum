/** biome-ignore-all lint/suspicious/useAwait: Async React act flushes queued effects and promises. */
/** biome-ignore-all lint/performance/noJsxPropsBind: The harness drives real state transitions. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import type { RailView } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import { RailPane } from "./rail-pane.tsx";
import { railScope } from "./scope-storage.ts";

// A rail row can be newer than the pane's own list. Clicking it must never
// make the pane say the item is gone or under Everyone: the pane looks again
// first.

const card = (id: string) => ({
  agentId: "a1",
  agentName: "Alpha",
  at: "2026-10-31T01:00:00.000Z",
  detail: "",
  expiresAt: null,
  id,
  kind: "question" as const,
  mail: null,
  passedOnBy: null,
  runId: null,
  status: "Waiting",
  threadId: null,
  title: `Title ${id}`,
});
const item = (id: string) => ({
  assigneeName: null,
  assigneeUserId: null,
  cards: [card(id)],
  dueAt: null,
  escalatedToMe: false,
  id,
  mine: true,
});
const view = (ids: string[]): RailView => ({
  counts: { everyone: ids.length, mine: ids.length },
  doneToday: 0,
  needsYou: ids.map(item),
  setup: [],
  working: [],
});

let server: Record<"everyone" | "mine", RailView> = {
  everyone: view(["m"]),
  mine: view(["m"]),
};
let hold = false;
let held: (() => void)[] = [];

const dom = new Window({ url: "http://localhost/" });
const previous = new Map<string, PropertyDescriptor | undefined>();
const KEYS = [
  "window",
  "document",
  "navigator",
  "Event",
  "HTMLElement",
  "Node",
  "MutationObserver",
  "IS_REACT_ACT_ENVIRONMENT",
];

beforeAll(() => {
  for (const key of KEYS) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  mock.module("#/integrations/trpc/client", () => ({
    getTrpc: () => ({
      desk: {
        rail: {
          query: ({ scope }: { scope: "everyone" | "mine" }) => {
            // The answer is read when the query starts, as a server would.
            const answer = server[scope];
            if (!hold) {
              return Promise.resolve(answer);
            }
            return new Promise<RailView>((resolve) => {
              held.push(() => resolve(answer));
            });
          },
        },
      },
      requests: { pending: { query: () => Promise.resolve([]) } },
      skillStore: { proposals: { query: () => Promise.resolve([]) } },
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

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const probe: { open: (id: string) => void } = { open: () => undefined };
function App() {
  const [openId, setOpenId] = useState("m");
  probe.open = setOpenId;
  return (
    <RouterContextProvider router={router}>
      <RailPane inline={false} item={openId} onOpen={() => undefined} />
    </RouterContextProvider>
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

const FALSE_CLAIMS = ["under Everyone", "not waiting any more"];

for (const scope of ["mine", "everyone"] as const) {
  test(`a row newer than the pane's list opens its card under ${scope}, never a false message`, async () => {
    hold = false;
    railScope.set(scope);
    server = { everyone: view(["m"]), mine: view(["m"]) };
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const seen: string[] = [];
    const observer = new MutationObserver(() => {
      seen.push(container.textContent ?? "");
    });
    observer.observe(container as unknown as Node, {
      characterData: true,
      childList: true,
      subtree: true,
    });

    await act(async () => root.render(<App />));
    await settle();
    expect(container.textContent).toContain("Title m");

    // A mail arrives. The rail has it; the pane's list is still the old one.
    server = { everyone: view(["n", "m"]), mine: view(["n", "m"]) };
    hold = true;
    held = [];
    await act(async () => probe.open("n"));
    expect(container.textContent).toContain("Looking for that item.");
    for (const claim of FALSE_CLAIMS) {
      expect(container.textContent).not.toContain(claim);
    }
    hold = false;
    await act(async () => {
      for (const release of held.splice(0)) {
        release();
      }
    });
    await settle();

    expect(container.textContent).toContain("Title n");
    for (const claim of FALSE_CLAIMS) {
      for (const text of seen) {
        expect(text).not.toContain(claim);
      }
    }
    observer.disconnect();
    await act(async () => root.unmount());
  });
}

test("an item that is truly gone is still said to be gone, after the pane looks again", async () => {
  hold = false;
  railScope.set("everyone");
  server = { everyone: view(["m"]), mine: view(["m"]) };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => root.render(<App />));
  await settle();
  await act(async () => probe.open("zzz"));
  await settle();

  expect(container.textContent).toContain("not waiting any more");
  await act(async () => root.unmount());
});
