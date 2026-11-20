import { expect, test } from "bun:test";
import type { AgentCard, AgentCardState } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type { NeedsYouChip } from "./roster-logic.ts";
import { RosterWall } from "./roster-wall.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const card = (name: string, state: AgentCardState, id = name): AgentCard => ({
  avatar: { color: "slate", glyph: name.charAt(0) },
  costThisWeekCents: 0,
  id,
  isLead: false,
  jobLine: "",
  learnedCount: 0,
  name,
  needsYouCount: 0,
  ownerName: "Dom",
  slug: name.toLowerCase(),
  state,
  statusLine: "Idle",
  teamId: null,
  weeklyCapCents: null,
});

const render = (
  cards: readonly AgentCard[],
  chips: readonly NeedsYouChip[] = []
) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <RosterWall cards={cards} chips={chips} />
    </RouterContextProvider>
  );

const EMPTY_TEXT =
  "No agents yet. Describe your first job and an agent will do it.";

test("cards come out in state order whatever the input order", () => {
  const html = render([
    card("Idle one", "idle"),
    card("Working one", "working"),
    card("Stopped one", "stopped"),
    card("Waiting one", "needs_you"),
  ]);
  const positions = [
    html.indexOf("Waiting one"),
    html.indexOf("Stopped one"),
    html.indexOf("Working one"),
    html.indexOf("Idle one"),
  ];
  for (const position of positions) {
    expect(position).toBeGreaterThan(-1);
  }
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
});

test("each card links to its agent", () => {
  const html = render([card("Ruby", "working", "agent_1")]);
  expect(html).toContain('href="/agents/agent_1"');
});

test("the empty state shows with zero cards and both add cards still link to /agents/new", () => {
  const html = render([]);
  expect(html).toContain(EMPTY_TEXT);
  expect(html.split('href="/agents/new"').length - 1).toBe(2);
  expect(html).toContain("New agent");
  expect(html).toContain("Start from a template");
});

test("the empty state is absent once an agent exists", () => {
  expect(render([card("Ruby", "idle")])).not.toContain(EMPTY_TEXT);
});

test("chips render as links to their item with a Needs you heading", () => {
  const html = render(
    [card("Ruby", "idle")],
    [{ href: "/desk?item=abc", id: "abc", title: "Approve the invoice" }]
  );
  expect(html).toContain('aria-label="Needs you"');
  expect(html).toContain("Needs you</h2>");
  expect(html).toContain('href="/desk?item=abc"');
  expect(html).toContain("Approve the invoice");
});

test("no chips means no Needs you strip", () => {
  const html = render([card("Ruby", "idle")]);
  expect(html).not.toContain("Needs you");
});
