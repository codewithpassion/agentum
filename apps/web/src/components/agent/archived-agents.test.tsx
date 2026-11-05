/** biome-ignore-all lint/suspicious/useAwait: React act flushes queued updates. */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { RAIL_REFRESH_EVENT } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { Window } from "happy-dom";
import { act, useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { toast } from "sonner";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import { ArchivedAgentBanner, ArchivedAgents } from "./archived-agents";

const dom = new Window();
const previous = new Map<string, PropertyDescriptor | undefined>();
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "Event",
  "IS_REACT_ACT_ENVIRONMENT",
];
let refused = false;
let restored: string[] = [];
let refreshes = 0;
const agent = { id: "a1", name: "Alpha", slug: "alpha" };
const router = createRouter({
  history: createMemoryHistory(),
  routeTree: createRootRoute(),
});
router.invalidate = () => {
  refreshes += 1;
  return Promise.resolve();
};

beforeAll(() => {
  for (const key of keys) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: key === "IS_REACT_ACT_ENVIRONMENT" ? true : Reflect.get(dom, key),
    });
  }
  mock.module("#/integrations/trpc/client", () => ({
    getTrpc: () => ({
      agents: {
        restore: {
          mutate: ({ agentId }: { agentId: string }) => {
            restored.push(agentId);
            return refused
              ? Promise.reject(new Error("That address is now taken"))
              : Promise.resolve();
          },
        },
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

function Harness() {
  const [archived, setArchived] = useState(true);
  const onRestored = useCallback(() => setArchived(false), []);
  return (
    <>
      <p>{archived ? "" : "Active Alpha"}</p>
      <ArchivedAgents
        agents={archived ? [agent] : []}
        onRestored={onRestored}
      />
    </>
  );
}

test("toggle is conditional, closed by default, and restore moves the row and refreshes", async () => {
  refused = false;
  restored = [];
  let railRefreshes = 0;
  const onRefresh = () => {
    railRefreshes += 1;
  };
  window.addEventListener(RAIL_REFRESH_EVENT, onRefresh);
  const container = document.createElement("div");
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <RouterContextProvider router={router}>
        <Harness />
      </RouterContextProvider>
    )
  );
  expect(container.textContent).toContain("Archived (1)");
  expect(container.querySelector("button")?.getAttribute("aria-expanded")).toBe(
    "false"
  );
  expect(container.textContent).not.toContain("Restore");
  await act(async () => container.querySelector("button")?.click());
  expect(container.textContent).toContain("alpha");
  await act(async () => container.querySelectorAll("button")[1]?.click());
  expect(restored).toEqual(["a1"]);
  expect(refreshes).toBe(1);
  expect(railRefreshes).toBe(1);
  expect(
    toast
      .getHistory()
      .some((entry) => "title" in entry && entry.title === "Restored Alpha")
  ).toBe(true);
  window.removeEventListener(RAIL_REFRESH_EVENT, onRefresh);
  expect(container.textContent).toContain("Active Alpha");
  expect(container.textContent).not.toContain("Archived (");
  await act(async () => root.unmount());
});

test("an archived page has the banner and Restore, and a refusal shows the service message", async () => {
  refused = true;
  const container = document.createElement("div");
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <RouterContextProvider router={router}>
        <ArchivedAgentBanner agent={agent} />
      </RouterContextProvider>
    )
  );
  expect(container.textContent).toContain(
    "This agent is archived. It doesn't run and isn't offered anywhere."
  );
  expect(container.querySelector("button")?.textContent).toBe("Restore");
  await act(async () => container.querySelector("button")?.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "That address is now taken"
  );
  expect(container.querySelector("button")?.disabled).toBe(false);
  await act(async () => root.unmount());
});
