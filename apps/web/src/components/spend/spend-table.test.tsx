import { expect, test } from "bun:test";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpendTable, SpendWeek } from "./spend-logic.ts";
import { SpendTableView } from "./spend-table.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const weeks: SpendWeek[] = [
  { end: "2026-10-18", label: "Oct 12", start: "2026-10-12" },
  { end: "2026-10-25", label: "Oct 19", start: "2026-10-19" },
  { end: "2026-11-01", label: "Oct 26", start: "2026-10-26" },
  { end: "2026-11-08", label: "Last week", start: "2026-11-02" },
  { end: "2026-11-15", label: "This week", start: "2026-11-09" },
];

const table: SpendTable = {
  rows: [
    {
      agentId: "agent_123",
      capCents: 2000,
      centsByWeek: [0, 0, 0, 0, 410],
      name: "Ruby",
      paused: false,
      removed: false,
    },
    {
      agentId: "agent_456",
      capCents: null,
      centsByWeek: [100, 0, 0, 250, 0],
      name: "Opal",
      paused: true,
      removed: false,
    },
  ],
  totals: [100, 0, 0, 250, 410],
};

const render = (spend: SpendTable) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <SpendTableView table={spend} weeks={weeks} />
    </RouterContextProvider>
  );

test("the header shows the agent, the week labels and the limit", () => {
  const html = render(table);
  expect(html).toContain("Agent");
  expect(html).toContain("This week");
  expect(html).toContain("Last week");
  expect(html).toContain("Limit");
});

test("a row links to the agent and shows its week cost and limit", () => {
  const html = render(table);
  expect(html).toContain("Ruby");
  expect(html).toContain('href="/agents/agent_123"');
  expect(html).toContain("$4.10");
  expect(html).toContain("$20");
});

test("a paused row says so in text", () => {
  const html = render(table);
  expect(html).toContain("Opal");
  expect(html).toContain("Paused");
});

test("a null cap shows None", () => {
  expect(render(table)).toContain("None");
});

test("the total row sums each week", () => {
  const html = render(table);
  const totalRow = html.slice(html.indexOf("Total"));
  expect(totalRow).toContain("$1.00");
  expect(totalRow).toContain("$2.50");
  expect(totalRow).toContain("$4.10");
});

test("no rows renders the empty message and no table", () => {
  const html = render({ rows: [], totals: [0, 0, 0, 0, 0] });
  expect(html).toContain("No spend in the last five weeks.");
  expect(html).not.toContain("<table");
});
