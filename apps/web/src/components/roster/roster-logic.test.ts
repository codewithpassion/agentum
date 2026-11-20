import { expect, test } from "bun:test";
import type {
  AgentCard,
  AgentCardState,
  RailItem,
  Team,
} from "@repo/db/shared";
import {
  chipsOf,
  collapsedKey,
  groupCards,
  NO_TEAM_KEY,
  readCollapsed,
  sortCards,
  toggleKey,
  weekCostLabel,
  writeCollapsed,
} from "./roster-logic.ts";

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

const team = (
  id: string,
  name: string,
  leadAgentId: string | null = null
): Team => ({
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  folderPath: null,
  id,
  leadAgentId,
  leadListens: false,
  members: [],
  name,
  ownerUserId: null,
  rules: "",
  slug: id,
});

const onTeam = (
  base: AgentCard,
  teamId: string | null,
  needsYouCount = 0
): AgentCard => ({ ...base, needsYouCount, teamId });

test("cards group under their home team", () => {
  const teams = [team("a", "Alpha"), team("b", "Beta")];
  const groups = groupCards(
    [
      onTeam(card("Ann", "idle"), "a"),
      onTeam(card("Bo", "idle"), "b"),
      onTeam(card("Cy", "idle"), "a"),
    ],
    teams
  );
  expect(groups.map((g) => g.key)).toEqual(["a", "b"]);
  expect(groups.at(0)?.cards.map((c) => c.name)).toEqual(["Ann", "Cy"]);
  expect(groups.at(1)?.cards.map((c) => c.name)).toEqual(["Bo"]);
  expect(groups.at(0)?.team?.id).toBe("a");
});

test("team groups are ordered by team name, then id", () => {
  const groups = groupCards(
    [],
    [
      team("z", "Zulu"),
      team("b", "Same"),
      team("a", "Same"),
      team("m", "Alpha"),
    ]
  );
  expect(groups.map((g) => g.key)).toEqual(["m", "a", "b", "z"]);
});

test("an empty team still gets a group with no cards", () => {
  const groups = groupCards([], [team("a", "Alpha")]);
  expect(groups).toHaveLength(1);
  expect(groups.at(0)?.cards).toEqual([]);
  expect(groups.at(0)?.needsYouCount).toBe(0);
});

test("the No team group comes last and only when it has cards", () => {
  const teams = [team("a", "Alpha")];
  const withoutHomeless = groupCards([onTeam(card("Ann", "idle"), "a")], teams);
  expect(withoutHomeless.map((g) => g.key)).toEqual(["a"]);

  const withHomeless = groupCards(
    [onTeam(card("Ann", "idle"), null), onTeam(card("Bo", "idle"), "a")],
    teams
  );
  expect(withHomeless.map((g) => g.key)).toEqual(["a", NO_TEAM_KEY]);
  expect(withHomeless[1]).toMatchObject({ leadName: null, team: null });
});

test("a card naming a team that is not listed lands in No team", () => {
  const groups = groupCards(
    [onTeam(card("Ghost", "idle"), "gone")],
    [team("a", "Alpha")]
  );
  expect(groups.map((g) => g.key)).toEqual(["a", NO_TEAM_KEY]);
  expect(groups.at(1)?.cards.map((c) => c.name)).toEqual(["Ghost"]);
});

test("the lead name is found in any group, and null without a lead", () => {
  const teams = [
    team("a", "Alpha", "lead_1"),
    team("b", "Beta", "lead_missing"),
    team("c", "Gamma", null),
  ];
  const groups = groupCards(
    [
      onTeam(card("Ruby", "working", "lead_1"), null),
      onTeam(card("Bo", "idle"), "a"),
    ],
    teams
  );
  const byKey = new Map(groups.map((g) => [g.key, g.leadName]));
  expect(byKey.get("a")).toBe("Ruby");
  expect(byKey.get("b")).toBeNull();
  expect(byKey.get("c")).toBeNull();
});

test("needsYouCount sums the group's cards", () => {
  const groups = groupCards(
    [
      onTeam(card("Ann", "needs_you"), "a", 2),
      onTeam(card("Bo", "needs_you"), "a", 3),
    ],
    [team("a", "Alpha")]
  );
  expect(groups.at(0)?.needsYouCount).toBe(5);
});

test("cards inside a group come in state order", () => {
  const groups = groupCards(
    [
      onTeam(card("Idle", "idle"), "a"),
      onTeam(card("Waiting", "needs_you"), "a"),
    ],
    [team("a", "Alpha")]
  );
  expect(groups.at(0)?.cards.map((c) => c.state)).toEqual([
    "needs_you",
    "idle",
  ]);
});

test("collapsed keys round trip per user", () => {
  const data = new Map<string, string>();
  const storage = () => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  });
  writeCollapsed(storage, "user_a", new Set(["a", "b"]));
  expect([...readCollapsed(storage, "user_a")].sort()).toEqual(["a", "b"]);
  expect([...readCollapsed(storage, "user_b")]).toEqual([]);
  expect(collapsedKey("user_a")).toBe("hm:roster-collapsed:user_a");
});

test("malformed storage and a throwing getter read as nothing collapsed", () => {
  const malformed = () => ({
    getItem: () => '{"not": "an array"}',
    setItem: () => undefined,
  });
  const mixed = () => ({
    getItem: () => '["a", 3, null, "b"]',
    setItem: () => undefined,
  });
  const blocked = (): never => {
    throw new Error("storage blocked");
  };
  expect([
    ...readCollapsed(
      () => ({ getItem: () => "not json", setItem: () => undefined }),
      "u"
    ),
  ]).toEqual([]);
  expect([...readCollapsed(malformed, "u")]).toEqual([]);
  expect([...readCollapsed(mixed, "u")]).toEqual(["a", "b"]);
  expect([...readCollapsed(blocked, "u")]).toEqual([]);
});

test("a throwing setItem does not throw", () => {
  const blocked = () => ({
    getItem: () => null,
    setItem: () => {
      throw new Error("quota exceeded");
    },
  });
  expect(() => writeCollapsed(blocked, "u", new Set(["a"]))).not.toThrow();
});

test("toggleKey adds, removes and never changes the input", () => {
  const input: ReadonlySet<string> = new Set(["a"]);
  const added = toggleKey(input, "b");
  expect([...added].sort()).toEqual(["a", "b"]);
  const removed = toggleKey(input, "a");
  expect([...removed]).toEqual([]);
  expect([...input]).toEqual(["a"]);
});
