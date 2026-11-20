import { expect, test } from "bun:test";
import type { RailItem } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { NeedsYouRow } from "./rail-needs-you.tsx";

const noop = () => undefined;
const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const item: RailItem = {
  assigneeName: null,
  assigneeUserId: null,
  cards: [
    {
      agentAvatar: { color: "teal", glyph: "Q" },
      agentId: "agent_1",
      agentName: "Sorter",
      at: "2026-11-20T09:00:00.000Z",
      detail: "",
      expiresAt: null,
      id: "card_1",
      kind: "question",
      mail: null,
      passedOnBy: null,
      runId: null,
      status: "Asks you",
      threadId: null,
      title: "Which folder?",
    },
  ],
  dueAt: null,
  escalatedToMe: false,
  id: "item_1",
  mine: true,
};

test("a row's tile draws the agent's stored glyph and colour, not initials of its name", () => {
  const html = renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <NeedsYouRow
        fresh={false}
        item={item}
        now={new Date("2026-11-20T10:00:00.000Z")}
        onNavigate={noop}
        open={false}
        scope="mine"
      />
    </RouterContextProvider>
  );
  expect(html).toContain("bg-teal-600");
  expect(html).toContain('data-testid="agent-tile">Q</span>');
  expect(html).not.toContain(">SO</span>");
});
