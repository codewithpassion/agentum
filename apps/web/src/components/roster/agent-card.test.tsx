import { expect, test } from "bun:test";
import type { AgentCard } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentCardView } from "./agent-card.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const baseCard: AgentCard = {
  avatar: { color: "blue", glyph: "R" },
  costThisWeekCents: 410,
  id: "agent_123",
  isLead: false,
  jobLine: "Reviews incoming vendor invoices",
  learnedCount: 0,
  name: "Ruby",
  needsYouCount: 0,
  ownerName: "Dom Fretz",
  slug: "ruby",
  state: "working",
  statusLine: "Matching invoice 88 to a purchase order",
  teamId: null,
  weeklyCapCents: null,
};

const render = (card: AgentCard) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <AgentCardView card={card} />
    </RouterContextProvider>
  );

test("the card links to the agent", () => {
  expect(render(baseCard)).toContain('href="/agents/agent_123"');
});

test("the card shows name, job line, status line, owner and week cost", () => {
  const html = render(baseCard);
  expect(html).toContain("Ruby");
  expect(html).toContain("Reviews incoming vendor invoices");
  expect(html).toContain("Matching invoice 88 to a purchase order");
  expect(html).toContain("Owner Dom Fretz");
  expect(html).toContain("$4.10 this week");
});

test("a card with a weekly limit reads spend against it", () => {
  const html = render({ ...baseCard, weeklyCapCents: 2000 });
  expect(html).toContain("$4.10 of $20 this week");
  expect(html).not.toContain("$4.10 this week");
});

test("a needs_you card says so in text and takes the amber accent", () => {
  const html = render({ ...baseCard, state: "needs_you" });
  expect(html).toContain("Needs you");
  expect(html).toContain("border-l-amber-500");
});

test("the glyph and the colour class appear", () => {
  const html = render(baseCard);
  expect(html).toContain(">R<");
  expect(html).toContain("bg-blue-600");
});

test("a team lead card shows a Lead badge", () => {
  const html = render({ ...baseCard, isLead: true });
  expect(html).toContain("Lead");
  expect(html).toContain(">Lead<");
});

test("a card that is not a lead shows no Lead badge", () => {
  const html = render(baseCard);
  expect(html).not.toContain(">Lead<");
});

test("an empty job line renders no job paragraph", () => {
  const html = render({ ...baseCard, jobLine: "" });
  expect(html).not.toContain("text-muted-foreground text-sm");
  expect(html).toContain("Matching invoice 88 to a purchase order");
});
