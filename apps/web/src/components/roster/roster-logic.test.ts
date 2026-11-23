import { expect, test } from "bun:test";
import type {
  AgentCard,
  AgentCardState,
  RailItem,
  Team,
} from "@repo/db/shared";
import {
  cardStatusLine,
  chipsOf,
  collapsedKey,
  filterCards,
  groupCards,
  NO_TEAM_KEY,
  ROSTER_VIEW_KEY,
  readCollapsed,
  readView,
  sortCards,
  startsSearch,
  toggleKey,
  wallIsFlat,
  weekCostLabel,
  writeCollapsed,
  writeView,
} from "./roster-logic.ts";

const card = (name: string, state: AgentCardState, id = name): AgentCard => ({
  avatar: { color: "slate", glyph: name.charAt(0) },
  doneAt: null,
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
  const teams = [
    team("z", "Zulu"),
    team("b", "Same"),
    team("a", "Same"),
    team("m", "Alpha"),
  ];
  const groups = groupCards(
    teams.map((t) => onTeam(card(t.id, "idle"), t.id)),
    teams
  );
  expect(groups.map((g) => g.key)).toEqual(["m", "a", "b", "z"]);
});

test("empty team groups are left out", () => {
  const groups = groupCards(
    [onTeam(card("Ann", "idle"), "b")],
    [team("a", "Alpha"), team("b", "Beta"), team("c", "Gamma")]
  );
  expect(groups.map((g) => g.key)).toEqual(["b"]);
});

test("wallIsFlat is true when there are no groups", () => {
  expect(wallIsFlat([])).toBe(true);
});

test("wallIsFlat is true when the only group is Everyone", () => {
  const groups = groupCards(
    [onTeam(card("Ann", "idle"), "everyone")],
    [team("everyone", "Everyone")]
  );
  expect(wallIsFlat(groups)).toBe(true);
});

test("wallIsFlat is false when the only group is another team", () => {
  const groups = groupCards(
    [onTeam(card("Ann", "idle"), "a")],
    [team("a", "Alpha")]
  );
  expect(wallIsFlat(groups)).toBe(false);
});

test("wallIsFlat is false when Everyone sits beside another team", () => {
  const groups = groupCards(
    [onTeam(card("Ann", "idle"), "everyone"), onTeam(card("Bo", "idle"), "a")],
    [team("everyone", "Everyone"), team("a", "Alpha")]
  );
  expect(groups.map((g) => g.key)).toEqual(["a", "everyone"]);
  expect(wallIsFlat(groups)).toBe(false);
});

test("wallIsFlat is true for a lone No team group", () => {
  const groups = groupCards([onTeam(card("Ann", "idle"), null)], []);
  expect(groups.map((g) => g.key)).toEqual([NO_TEAM_KEY]);
  expect(wallIsFlat(groups)).toBe(true);
});

test("wallIsFlat is true for Everyone beside No team", () => {
  const groups = groupCards(
    [onTeam(card("Ann", "idle"), "everyone"), onTeam(card("Bo", "idle"), null)],
    [team("everyone", "Everyone")]
  );
  expect(groups.map((g) => g.key)).toEqual(["everyone", NO_TEAM_KEY]);
  expect(wallIsFlat(groups)).toBe(true);
});

test("wallIsFlat is false for another team beside No team", () => {
  const groups = groupCards(
    [onTeam(card("Ann", "idle"), "a"), onTeam(card("Bo", "idle"), null)],
    [team("a", "Alpha")]
  );
  expect(wallIsFlat(groups)).toBe(false);
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
    [onTeam(card("Ann", "idle"), "a"), onTeam(card("Ghost", "idle"), "gone")],
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
      onTeam(card("Cy", "idle"), "b"),
      onTeam(card("Di", "idle"), "c"),
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

const SYDNEY = { locale: "en-AU", timeZone: "Australia/Sydney" };
const DONE_CARD: AgentCard = {
  ...card("Ada", "idle"),
  doneAt: "2026-11-20T09:13:00.000Z",
  statusLine: "Done: Prepare the report. Next run 21 Nov, 8:00 am AEDT",
};

test("a finished card prints its time in the viewer's zone, and leaves the schedule as the server wrote it", () => {
  expect(cardStatusLine(DONE_CARD, SYDNEY)).toBe(
    "Done 8:13 pm: Prepare the report. Next run 21 Nov, 8:00 am AEDT"
  );
  expect(cardStatusLine(DONE_CARD, { ...SYDNEY, timeZone: "UTC" })).toBe(
    "Done 9:13 am: Prepare the report. Next run 21 Nov, 8:00 am AEDT"
  );
});

test("a card with no finish time shows its status line as it is", () => {
  expect(cardStatusLine({ ...DONE_CARD, doneAt: null }, SYDNEY)).toBe(
    DONE_CARD.statusLine
  );
  expect(cardStatusLine(card("Ada", "idle"), SYDNEY)).toBe("Idle");
});

test("filterCards matches a name fragment in any case and keeps all on an empty query", () => {
  const cards = [card("Ada", "idle"), card("Bruce", "idle")];
  expect(filterCards(cards, "").length).toBe(2);
  expect(filterCards(cards, "  ").length).toBe(2);
  expect(filterCards(cards, "RUC").map((c) => c.name)).toEqual(["Bruce"]);
  expect(filterCards(cards, "zz")).toEqual([]);
});

test("readView falls back to the grid and writeView keeps the list choice", () => {
  const data = new Map<string, string>();
  const storage = () => ({
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  });
  expect(readView(storage)).toBe("grid");
  writeView(storage, "list");
  expect(data.get(ROSTER_VIEW_KEY)).toBe("list");
  expect(readView(storage)).toBe("list");
  data.set(ROSTER_VIEW_KEY, "nonsense");
  expect(readView(storage)).toBe("grid");
});

test("blocked storage reads as the grid and a write does not throw", () => {
  const blocked = () => {
    throw new Error("blocked");
  };
  expect(readView(blocked)).toBe("grid");
  expect(() => writeView(blocked, "list")).not.toThrow();
});

test("startsSearch accepts a plain printable key only", () => {
  const key = (k: string, mods = {}) => ({
    altKey: false,
    ctrlKey: false,
    key: k,
    metaKey: false,
    ...mods,
  });
  expect(startsSearch(key("a"))).toBe(true);
  expect(startsSearch(key("A"))).toBe(true);
  expect(startsSearch(key("a", { ctrlKey: true }))).toBe(false);
  expect(startsSearch(key("a", { metaKey: true }))).toBe(false);
  expect(startsSearch(key("a", { altKey: true }))).toBe(false);
  expect(startsSearch(key(" "))).toBe(false);
  expect(startsSearch(key("Enter"))).toBe(false);
  expect(startsSearch(key("Escape"))).toBe(false);
});
