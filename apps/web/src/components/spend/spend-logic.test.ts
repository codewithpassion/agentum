import { expect, test } from "bun:test";
import {
  buildSpendTable,
  capInputValue,
  capLabel,
  capLine,
  dayInZone,
  parseCapInput,
  spendRange,
  spendWeeks,
} from "./spend-logic.ts";

// Friday 20 November 2026, 09:00 in Sydney, which is Thursday 22:00 UTC.
const NOW = new Date("2026-11-19T22:00:00Z");

test("the day follows the workspace timezone", () => {
  expect(dayInZone(NOW, "Australia/Sydney")).toBe("2026-11-20");
  expect(dayInZone(NOW, "UTC")).toBe("2026-11-19");
});

test("five Monday weeks, oldest first, the last ending today", () => {
  const weeks = spendWeeks(NOW, "Australia/Sydney");
  expect(weeks.map((week) => week.start)).toEqual([
    "2026-10-19",
    "2026-10-26",
    "2026-11-02",
    "2026-11-09",
    "2026-11-16",
  ]);
  expect(weeks.map((week) => week.label)).toEqual([
    "Oct 19",
    "Oct 26",
    "Nov 2",
    "Last week",
    "This week",
  ]);
  expect(weeks[3]?.end).toBe("2026-11-15");
  expect(weeks[4]?.end).toBe("2026-11-20");
  expect(spendRange(weeks)).toEqual({ from: "2026-10-19", to: "2026-11-20" });
});

test("a Sunday belongs to the week that began the Monday before", () => {
  const sunday = new Date("2026-11-22T03:00:00Z");
  expect(spendWeeks(sunday, "UTC").at(-1)?.start).toBe("2026-11-16");
});

test("the cap line reads dollars, and is null without a cap", () => {
  expect(capLine(410, 2000)).toBe("$4.10 of $20 this week");
  expect(capLine(0, 2050)).toBe("$0 of $20.50 this week");
  expect(capLine(410, null)).toBeNull();
  expect(capLabel(500)).toBe("$5");
});

test("a cap input reads dollars to cents", () => {
  expect(parseCapInput("20")).toEqual({ cents: 2000, ok: true });
  expect(parseCapInput(" $12.5 ")).toEqual({ cents: 1250, ok: true });
  expect(parseCapInput("0.05")).toEqual({ cents: 5, ok: true });
  expect(parseCapInput("")).toEqual({ cents: null, ok: true });
});

test("a cap input refuses zero, negatives and text", () => {
  for (const text of ["0", "0.00", "-3", "abc", "1.234", "1e3"]) {
    expect(parseCapInput(text).ok).toBe(false);
  }
});

test("a saved cap fills the input", () => {
  expect(capInputValue(2050)).toBe("20.5");
  expect(capInputValue(null)).toBe("");
});

test("the table sums agent days into weeks and sorts this week first", () => {
  const weeks = spendWeeks(NOW, "Australia/Sydney");
  const table = buildSpendTable({
    agents: [
      { id: "a", name: "Ada" },
      { id: "b", name: "Bo" },
    ],
    caps: [
      {
        agentId: "a",
        pausedAt: null,
        pausedReason: null,
        weeklyCapCents: 2000,
      },
      {
        agentId: "b",
        pausedAt: "2026-11-20T00:00:00Z",
        pausedReason: "spend_cap",
        weeklyCapCents: 100,
      },
    ],
    rows: [
      { agentId: "a", cents: 100, day: "2026-11-03", tasks: 1 },
      { agentId: "a", cents: 50, day: "2026-11-17", tasks: 2 },
      { agentId: "b", cents: 120, day: "2026-11-18", tasks: 3 },
      { agentId: "b", cents: 120, day: "2026-11-19", tasks: 1 },
      { agentId: "gone", cents: 9, day: "2026-11-10", tasks: 1 },
      { agentId: "a", cents: 999, day: "2026-10-01", tasks: 1 },
    ],
    weeks,
  });
  expect(table.rows.map((row) => row.name)).toEqual([
    "Bo",
    "Ada",
    "Removed agent",
  ]);
  expect(table.rows[0]?.centsByWeek).toEqual([0, 0, 0, 0, 240]);
  expect(table.rows[0]?.paused).toBe(true);
  expect(table.rows[0]?.tasksThisWeek).toBe(4);
  expect(table.rows[1]?.capCents).toBe(2000);
  expect(table.totals).toEqual([0, 0, 100, 9, 290]);
});
