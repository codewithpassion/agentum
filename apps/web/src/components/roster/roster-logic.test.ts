import { expect, test } from "bun:test";
import type { AgentCard, AgentCardState, RailItem } from "@repo/db/shared";
import { chipsOf, sortCards, weekCostLabel } from "./roster-logic.ts";

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

test("cards sort needs_you, stopped, working, idle", () => {
  const sorted = sortCards([
    card("Idle one", "idle"),
    card("Working one", "working"),
    card("Stopped one", "stopped"),
    card("Waiting one", "needs_you"),
  ]);
  expect(sorted.map((c) => c.state)).toEqual([
    "needs_you",
    "stopped",
    "working",
    "idle",
  ]);
});

test("cards in one state read by name, and the input is not changed", () => {
  const input = [card("Zed", "idle"), card("Ann", "idle")];
  expect(sortCards(input).map((c) => c.name)).toEqual(["Ann", "Zed"]);
  expect(input.map((c) => c.name)).toEqual(["Zed", "Ann"]);
});

test("an empty roster sorts to an empty list", () => {
  expect(sortCards([])).toEqual([]);
});

test("cost reads in dollars, with none and under-a-cent spelled out", () => {
  expect(weekCostLabel(0)).toBe("$0");
  expect(weekCostLabel(0.4)).toBe("<$0.01");
  expect(weekCostLabel(410)).toBe("$4.10");
});

test("a chip links to the item pane and skips an item with no card", () => {
  const item = (id: string, titles: string[]): RailItem => ({
    assigneeName: null,
    assigneeUserId: null,
    cards: titles.map((title) => ({ title }) as RailItem["cards"][number]),
    dueAt: null,
    escalatedToMe: false,
    id,
    mine: true,
  });
  expect(chipsOf([item("a b", ["Pay invoice"]), item("c", [])])).toEqual([
    { href: "/desk?item=a%20b", id: "a b", title: "Pay invoice" },
  ]);
});
