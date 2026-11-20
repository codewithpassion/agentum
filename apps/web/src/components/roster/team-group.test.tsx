import { expect, test } from "bun:test";
import type { AgentCard, Team } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NO_TEAM_KEY, type RosterGroup } from "./roster-logic.ts";
import { TeamGroup } from "./team-group.tsx";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const card = (name: string): AgentCard => ({
  avatar: { color: "slate", glyph: name.charAt(0) },
  costThisWeekCents: 0,
  doneAt: null,
  id: name,
  isLead: false,
  jobLine: "",
  learnedCount: 0,
  name,
  needsYouCount: 0,
  ownerName: "Dom",
  slug: name.toLowerCase(),
  state: "idle",
  statusLine: "Idle",
  teamId: null,
  weeklyCapCents: null,
});

const team: Team = {
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  folderPath: null,
  id: "t1",
  leadAgentId: "ruby",
  leadListens: true,
  members: [],
  name: "Core team",
  ownerUserId: null,
  rules: "",
  slug: "core-team",
};

const teamGroup = (overrides: Partial<RosterGroup> = {}): RosterGroup => ({
  cards: [card("Ruby"), card("Opal")],
  key: "t1",
  leadName: "Ruby",
  needsYouCount: 0,
  team,
  ...overrides,
});

const render = (group: RosterGroup, collapsed = false, content?: ReactNode) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <TeamGroup collapsed={collapsed} group={group} onToggle={noop}>
        {content ?? <p data-testid="child">Cards</p>}
      </TeamGroup>
    </RouterContextProvider>
  );

const CHILD = 'data-testid="child"';
const ARIA_CONTROLS = /aria-controls="([^"]+)"/;
const ARIA_LABELLED_BY = /aria-labelledby="([^"]+)"/;
const noop = (): void => undefined;

test("a team group shows its team name as the heading", () => {
  expect(render(teamGroup())).toContain(">Core team</span>");
});

test("a team group links to its room, with a distinct accessible name", () => {
  const html = render(teamGroup());
  expect(html).toContain('href="/teams/t1/room"');
  expect(html).toContain("Open room</a>");
  expect(html).toContain('aria-label="Open room for Core team"');
});

test("the no-team group has a No team heading and no room link", () => {
  const html = render(
    teamGroup({ key: NO_TEAM_KEY, leadName: null, team: null })
  );
  expect(html).toContain(">No team</span>");
  expect(html).not.toContain("Open room");
  expect(html).not.toContain("/room");
});

test("the summary names the lead and counts agents and requests", () => {
  const html = render(teamGroup({ needsYouCount: 1 }));
  expect(html).toContain("Lead Ruby · 2 agents · 1 needs you");
});

test("a team without a lead says No lead", () => {
  const html = render(teamGroup({ leadName: null }));
  expect(html).toContain("No lead · 2 agents");
});

test("one agent is singular and zero agents reads 0 agents", () => {
  expect(render(teamGroup({ cards: [card("Ruby")] }))).toContain(
    "Lead Ruby · 1 agent"
  );
  expect(render(teamGroup({ cards: [] }))).toContain("Lead Ruby · 0 agents");
});

test("several requests read need you, one reads needs you", () => {
  expect(render(teamGroup({ needsYouCount: 2 }))).toContain("2 need you");
  expect(render(teamGroup({ needsYouCount: 1 }))).toContain("1 needs you");
});

test("the no-team summary has only the agent count and the requests", () => {
  const html = render(
    teamGroup({
      cards: [card("Ruby")],
      key: NO_TEAM_KEY,
      leadName: null,
      needsYouCount: 3,
      team: null,
    })
  );
  expect(html).toContain("1 agent · 3 need you");
  expect(html).not.toContain("Lead");
  expect(html).not.toContain("No lead");
});

test("an open group renders its children and aria-expanded is true", () => {
  const html = render(teamGroup(), false);
  expect(html).toContain(CHILD);
  expect(html).toContain('aria-expanded="true"');
});

test("the toggle controls the content region, which exists when open", () => {
  const html = render(teamGroup(), false);
  const controls = ARIA_CONTROLS.exec(html)?.[1];
  expect(controls).toBeDefined();
  expect(html).toContain(`id="${controls}"`);
});

test("a collapsed group omits its children and aria-expanded is false", () => {
  const html = render(teamGroup(), true);
  expect(html).not.toContain(CHILD);
  expect(html).toContain('aria-expanded="false"');
});

test("the section is labelled by its heading", () => {
  const html = render(teamGroup());
  const labelledBy = ARIA_LABELLED_BY.exec(html)?.[1];
  expect(labelledBy).toBeDefined();
  expect(html).toContain(`id="${labelledBy}"`);
});
