import { expect, test } from "bun:test";
import type { Team } from "@repo/db/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { memberSummary, TeamList } from "./team-list.tsx";
import type { TeamAgent } from "./team-logic.ts";

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ["/"] }),
  routeTree: createRootRoute(),
});

const team = (overrides: Partial<Team> = {}): Team => ({
  archivedAt: null,
  createdAt: "2026-11-20T00:00:00.000Z",
  folderPath: null,
  id: "t1",
  leadAgentId: null,
  leadListens: true,
  members: [],
  name: "Sales",
  ownerUserId: null,
  rules: "",
  slug: "sales",
  ...overrides,
});

const member = (kind: "agent" | "user", id: string) => ({
  isHome: false,
  memberId: id,
  memberKind: kind,
  teamId: "t1",
});

const scout: TeamAgent = {
  avatar: { color: "slate", glyph: "S" },
  id: "a1",
  jobLine: "",
  name: "Scout",
};

const render = (teams: readonly Team[]) =>
  renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <TeamList agents={[scout]} teams={teams} />
    </RouterContextProvider>
  );

test("memberSummary counts agents and people and leaves out a kind with none", () => {
  expect(memberSummary(team())).toBe("No members yet");
  expect(memberSummary(team({ members: [member("agent", "a1")] }))).toBe(
    "1 agent"
  );
  expect(
    memberSummary(
      team({
        members: [
          member("agent", "a1"),
          member("agent", "a2"),
          member("user", "u1"),
        ],
      })
    )
  ).toBe("2 agents, 1 person");
  expect(memberSummary(team({ members: [member("user", "u1")] }))).toBe(
    "1 person"
  );
});

test("each team links to its page and names its lead", () => {
  const html = render([
    team({ leadAgentId: "a1", members: [member("agent", "a1")] }),
    team({ id: "t2", name: "Back office" }),
  ]);
  expect(html).toContain("Sales");
  expect(html).toContain("Scout leads");
  expect(html).toContain("Back office");
  expect(html).toContain("No lead");
});

test("no teams shows a note", () => {
  expect(render([])).toContain("No teams yet.");
});
