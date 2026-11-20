import { expect, test } from "bun:test";
import type { AgentCard, AgentCardState, Team } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
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

const team = (id: string, name: string, leadAgentId: string | null): Team => ({
  archivedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  folderPath: null,
  id,
  leadAgentId,
  leadListens: true,
  members: [],
  name,
  ownerUserId: null,
  rules: "",
  slug: name.toLowerCase(),
});

const addMember = () => Promise.resolve();

const render = (
  cards: readonly AgentCard[],
  chips: readonly NeedsYouChip[] = [],
  emptyState?: ReactNode,
  teams: readonly Team[] = []
) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <RosterWall
        cards={cards}
        chips={chips}
        emptyState={emptyState}
        onAddMember={addMember}
        teams={teams}
        userId="user_1"
      />
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

test("with no agents, the empty state replaces the line and the add cards", () => {
  const html = render([], [], <p data-testid="guide">Guide</p>);
  expect(html).toContain('data-testid="guide"');
  expect(html).not.toContain(EMPTY_TEXT);
  expect(html).not.toContain('href="/agents/new"');
  expect(html).not.toContain("<ul");
});

test("with agents, the empty state is ignored", () => {
  const html = render(
    [card("Ruby", "idle")],
    [],
    <p data-testid="guide">Guide</p>
  );
  expect(html).not.toContain('data-testid="guide"');
  expect(html.split('href="/agents/new"').length - 1).toBe(2);
});

const inTeam = (c: AgentCard, teamId: string, isLead = false): AgentCard => ({
  ...c,
  isLead,
  teamId,
});

test("with teams, cards group under their team heading and agents in no team come last", () => {
  const html = render(
    [
      card("Loner", "idle"),
      inTeam(card("Ruby", "idle", "a_ruby"), "t_ops", true),
      inTeam(card("Sam", "working", "a_sam"), "t_ops"),
      inTeam(card("Tess", "idle", "a_tess"), "t_dev"),
    ],
    [],
    undefined,
    [team("t_ops", "Ops", "a_ruby"), team("t_dev", "Dev", null)]
  );
  const order = ["Dev</span>", "Tess", "Ops</span>", "Ruby", "Sam", "No team"];
  const positions = order.map((text) => html.indexOf(text));
  for (const position of positions) {
    expect(position).toBeGreaterThan(-1);
  }
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(html).toContain("Lead Ruby");
  expect(html).toContain("No lead");
  expect(html).toContain("2 agents");
  expect(html).toContain('href="/teams/t_ops/room"');
  expect(html).toContain('href="/teams/t_dev/room"');
  expect(html).toContain("Lead</span>");
  expect(html.split("Add to team</button>").length - 1).toBe(2);
  // Both add cards still link to the builder, once, after the groups.
  expect(html.split('href="/agents/new"').length - 1).toBe(2);
});

test("a team with no agents gets no group, and No team still shows beside a real team", () => {
  const html = render(
    [card("Loner", "idle"), inTeam(card("Ruby", "idle", "a_ruby"), "t_ops")],
    [],
    undefined,
    [team("t_ops", "Ops", null), team("t_empty", "Empty", null)]
  );
  expect(html).toContain("Ops</span>");
  expect(html).toContain("No team");
  expect(html).not.toContain("Empty</span>");
  expect(html).not.toContain("/teams/t_empty/room");
  expect(html.split("Add to team</button>").length - 1).toBe(1);
});

test("with Everyone the only team holding agents, the wall is flat with no headings", () => {
  const html = render(
    [
      inTeam(card("Ruby", "idle", "a_ruby"), "t_all"),
      inTeam(card("Sam", "working", "a_sam"), "t_all"),
    ],
    [],
    undefined,
    [team("t_all", "Everyone", null), team("t_ops", "Ops", null)]
  );
  expect(html).toContain("Ruby");
  expect(html).toContain("Sam");
  expect(html).not.toContain("<h2");
  expect(html).not.toContain("Add to team");
  expect(html).not.toContain("Open room");
  expect(html.split('href="/agents/new"').length - 1).toBe(2);
});

test("a fresh workspace with agents in no team shows the flat wall, not a lone No team group", () => {
  const html = render(
    [card("Loner", "idle"), card("Other", "working")],
    [],
    undefined,
    [team("t_all", "Everyone", null)]
  );
  expect(html).toContain("Loner");
  expect(html).toContain("Other");
  expect(html).not.toContain("<h2");
  expect(html).not.toContain("No team");
  expect(html).not.toContain("Add to team");
});

test("a fresh workspace with only an empty Everyone team shows the empty state, no group", () => {
  const html = render([], [], <div data-testid="guide" />, [
    team("t_all", "Everyone", null),
  ]);
  expect(html).toContain('data-testid="guide"');
  expect(html).not.toContain("<h2");
  expect(html).not.toContain("Everyone");
});

test("Everyone with agents next to another team with agents still groups", () => {
  const html = render(
    [
      inTeam(card("Ruby", "idle", "a_ruby"), "t_all"),
      inTeam(card("Tess", "idle", "a_tess"), "t_dev"),
    ],
    [],
    undefined,
    [team("t_all", "Everyone", null), team("t_dev", "Dev", null)]
  );
  expect(html).toContain("Everyone</span>");
  expect(html).toContain("Dev</span>");
});

test("with no teams the wall stays flat, with no headings or Add to team", () => {
  const html = render([card("Ruby", "idle")]);
  expect(html).not.toContain("<h2");
  expect(html).not.toContain("Add to team");
  expect(html).not.toContain("No team");
});
