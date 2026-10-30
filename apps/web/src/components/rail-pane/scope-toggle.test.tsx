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
import { useRail, useRailScope } from "#/components/rail/use-rail.ts";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import { RailPane } from "./rail-pane.tsx";
import { railScope } from "./scope-storage.ts";

// The toggle in the rail and the open pane read one scope. With blocked
// storage the choice must still reach the pane, and a slow load for the old
// scope must not overwrite the new one.

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
  counts: { everyone: 2, mine: 1 },
  doneToday: 0,
  needsYou: ids.map(item),
  setup: [],
  working: [],
});
const VIEWS = { everyone: view(["m", "x"]), mine: view(["m"]) };

interface Call {
  resolve: (value: RailView) => void;
  scope: "everyone" | "mine";
}
let calls: Call[] = [];
let queries: ("everyone" | "mine")[] = [];
let auto = true;

const dom = new Window({ url: "http://localhost/" });
Object.defineProperty(dom, "localStorage", {
  configurable: true,
  get() {
    throw new Error("storage is blocked");
  },
});
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
            queries.push(scope);
            if (auto) {
              return Promise.resolve(VIEWS[scope]);
            }
            return new Promise<RailView>((resolve) => {
              calls.push({ resolve, scope });
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

const probe: { open: (id: string) => void; scope: string | null } = {
  open: () => undefined,
  scope: null,
};
function App() {
  const { scope } = useRailScope();
  useRail(scope, null);
  const [openId, setOpenId] = useState("m");
  probe.scope = scope;
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

const flush = async () => {
  await act(async () => {
    for (const call of calls.splice(0)) {
      call.resolve(VIEWS[call.scope]);
    }
  });
  await settle();
};

test("the toggle reaches the open pane with blocked storage, and a slow old load cannot overwrite it", async () => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => root.render(<App />));
  await settle();
  expect(probe.scope).toBe("mine");

  // Item x is not under Mine: the pane says so and shows no card.
  await act(async () => probe.open("x"));
  await settle();
  expect(container.textContent).toContain("under Everyone");
  expect(container.textContent).not.toContain("Title x");

  // The toggle flips to Everyone. Storage is blocked, so only the shared
  // store carries it. The pane fetches Everyone and shows the item.
  queries = [];
  await act(async () => railScope.set("everyone"));
  await settle();
  expect(probe.scope).toBe("everyone");
  expect(queries).not.toContain("mine");
  expect(container.textContent).toContain("Title x");
  expect(container.textContent).not.toContain("under Everyone");

  // A load for Everyone starts and stays in flight. The toggle goes back to
  // Mine and that load lands last: it must be dropped.
  auto = false;
  calls = [];
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  const slow = calls.splice(0);
  await act(async () => railScope.set("mine"));
  await flush();
  await act(async () => {
    for (const call of slow) {
      call.resolve(VIEWS[call.scope]);
    }
  });
  await settle();
  expect(probe.scope).toBe("mine");
  expect(container.textContent).not.toContain("Title x");
  // Back under Mine, x is looked for again: the old verdict is not reused.
  expect(container.textContent).not.toContain("under Everyone");
  await flush();
  expect(container.textContent).toContain("under Everyone");

  auto = true;
  await act(async () => root.unmount());
});
