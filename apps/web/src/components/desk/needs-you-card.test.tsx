import { expect, test } from "bun:test";
import type { DeskCard } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadBody } from "./needs-you-card.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const thread: DeskCard = {
  agentId: "agent_1",
  at: "2026-10-31T01:00:00.000Z",
  band: { text: "Waiting on a reply", tone: "waiting" },
  id: "thread_1",
  kind: "thread",
  lane: "needs_you",
  needsYouKind: "inbox_reply",
  startedBy: "agent_1",
  threadId: "thread_1",
  title: "Reply to Acme",
};

const noop = () => undefined;

const render = () =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <ThreadBody card={thread} onChanged={noop} />
    </RouterContextProvider>
  );

test("a thread card links to the thread and offers Dismiss", () => {
  const html = render();
  expect(html).toContain("Open thread");
  expect(html).toContain(">Dismiss</button>");
});
