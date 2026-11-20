/** biome-ignore-all lint/suspicious/useAwait: Async React act flushes queued effects and promises. */
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
import { EmptyThread as realEmptyThread } from "#/components/thread/empty-thread.tsx";
import { getTrpc as realGetTrpc } from "#/integrations/trpc/client";
import { fixtureRoom } from "../test-fixtures.tsx";

// A change of agent on the same page (a param-only navigation) must not keep
// the first agent's conversation under the second agent's header, because a
// send would go to the first agent.

const noop = (): void => undefined;
const gates = new Map<string, () => void>();
const mainFor = (agentId: string) =>
  new Promise<{ id: string }>((resolve) => {
    gates.set(agentId, () => resolve({ id: `session_${agentId}` }));
  });

const dom = new Window({ url: "http://localhost/" });
let previousGlobals: Record<string, unknown> = {};

beforeAll(() => {
  previousGlobals = {
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as Record<string, unknown>)
      .IS_REACT_ACT_ENVIRONMENT,
    window: globalThis.window,
  };
  Object.assign(globalThis, {
    document: dom.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom,
  });
  mock.module("#/integrations/trpc/client", () => ({
    getTrpc: () => ({
      sessions: {
        main: {
          mutate: ({ agentId }: { agentId: string }) => mainFor(agentId),
        },
      },
      tasks: {
        get: {
          query: ({ sessionId }: { sessionId: string }) =>
            Promise.resolve({
              agent: { id: sessionId.replace("session_", "") },
              run: null,
              session: { id: sessionId },
            }),
        },
      },
    }),
  }));
  mock.module("#/components/thread/empty-thread.tsx", () => ({
    EmptyThread: ({ task }: { task: { session: { id: string } } }) => (
      <p>thread {task.session.id}</p>
    ),
  }));
});

afterAll(() => {
  mock.module("#/integrations/trpc/client", () => ({ getTrpc: realGetTrpc }));
  mock.module("#/components/thread/empty-thread.tsx", () => ({
    EmptyThread: realEmptyThread,
  }));
  Object.assign(globalThis, previousGlobals);
});

test("the Chat tab drops the first agent's thread when the agent changes", async () => {
  const { ChatTab } = await import("./index.tsx");
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute(),
  });
  const forAgent = (id: string) => {
    const room = fixtureRoom();
    room.agent.id = id;
    return (
      <RouterContextProvider router={router}>
        <ChatTab nowMs={null} onOpenTab={noop} room={room} />
      </RouterContextProvider>
    );
  };
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);

  await act(async () => {
    root.render(forAgent("a"));
  });
  await act(async () => {
    gates.get("a")?.();
  });
  expect(container.textContent).toContain("thread session_a");

  // The second agent's thread has not loaded yet.
  await act(async () => {
    root.render(forAgent("b"));
  });
  expect(container.textContent).not.toContain("thread session_a");
  expect(container.textContent).toContain("Opening the conversation.");

  await act(async () => {
    gates.get("b")?.();
  });
  expect(container.textContent).toContain("thread session_b");
  await act(async () => {
    root.unmount();
  });
});
