import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { chartData, SpendChart } from "./spend-chart.tsx";
import type { SpendWeek } from "./spend-logic.ts";

const weeks: SpendWeek[] = [
  { end: "2026-11-01", label: "Oct 26", start: "2026-10-26" },
  { end: "2026-11-08", label: "Nov 2", start: "2026-11-02" },
  { end: "2026-11-15", label: "Last week", start: "2026-11-09" },
  { end: "2026-11-20", label: "This week", start: "2026-11-16" },
];

test("chartData keeps week order, converts cents to dollars and flags only the last week", () => {
  expect(chartData(weeks, [0, 250, 1999, 410])).toEqual([
    { cents: 0, current: false, dollars: 0, label: "Oct 26" },
    { cents: 250, current: false, dollars: 2.5, label: "Nov 2" },
    { cents: 1999, current: false, dollars: 19.99, label: "Last week" },
    { cents: 410, current: true, dollars: 4.1, label: "This week" },
  ]);
});

test("chartData counts a missing total as zero", () => {
  expect(chartData(weeks, [500])).toEqual([
    { cents: 500, current: false, dollars: 5, label: "Oct 26" },
    { cents: 0, current: false, dollars: 0, label: "Nov 2" },
    { cents: 0, current: false, dollars: 0, label: "Last week" },
    { cents: 0, current: true, dollars: 0, label: "This week" },
  ]);
});

test("chartData returns no points for no weeks", () => {
  expect(chartData([], [100, 200])).toEqual([]);
});

test("SpendChart renders on the server with a summary of this week", () => {
  const html = renderToStaticMarkup(
    <SpendChart capCents={2000} totals={[0, 250, 1999, 410]} weeks={weeks} />
  );
  expect(html).toContain('role="img"');
  expect(html).toContain('aria-label="Spend per week, this week $4.10"');
});

test("SpendChart renders without a cap", () => {
  const html = renderToStaticMarkup(
    <SpendChart capCents={null} totals={[]} weeks={weeks} />
  );
  expect(html).toContain('aria-label="Spend per week, this week $0"');
});
