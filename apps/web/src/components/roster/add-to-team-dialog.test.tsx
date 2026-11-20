import { expect, test } from "bun:test";
import type { AgentCard, Team } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { AddToTeamPicker, addCandidates } from "./add-to-team-dialog.tsx";

const card = (name: string, overrides: Partial<AgentCard> = {}): AgentCard => ({
  avatar: { color: "slate", glyph: name.charAt(0) },
  costThisWeekCents: 0,
  id: name.toLowerCase(),
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
  ...overrides,
});

const team = (
  id: string,
  name: string,
  memberIds: readonly string[] = []
): Team => ({
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  folderPath: null,
  id,
  leadAgentId: null,
  leadListens: false,
  members: memberIds.map((memberId) => ({
    isHome: true,
    memberId,
    memberKind: "agent",
    teamId: id,
  })),
  name,
  ownerUserId: null,
  rules: "",
  slug: name.toLowerCase(),
});

const noop = () => undefined;

test("addCandidates leaves out agents already in the team", () => {
  const ops = team("team_ops", "Ops", ["ruby"]);
  const names = addCandidates(ops, [card("Ruby"), card("Milo")]).map(
    (item) => item.name
  );
  expect(names).toEqual(["Milo"]);
});

test("addCandidates keeps agents of other teams and agents with no team", () => {
  const ops = team("team_ops", "Ops");
  const names = addCandidates(ops, [
    card("Ruby", { teamId: "team_sales" }),
    card("Milo", { teamId: null }),
  ]).map((item) => item.name);
  expect(names).toEqual(["Milo", "Ruby"]);
});

test("addCandidates sorts by name, then id", () => {
  const ops = team("team_ops", "Ops");
  const names = addCandidates(ops, [
    card("Zed"),
    card("amy"),
    card("Bea", { id: "b2" }),
    card("Bea", { id: "b1" }),
  ]).map((item) => `${item.name}:${item.id}`);
  expect(names).toEqual(["amy:amy", "Bea:b1", "Bea:b2", "Zed:zed"]);
});

test("the picker renders names, job lines and the home team name", () => {
  const html = renderToStaticMarkup(
    <AddToTeamPicker
      candidates={[
        card("Ruby", {
          jobLine: "Reviews vendor invoices",
          teamId: "team_ops",
        }),
      ]}
      error={null}
      homeTeamNames={new Map([["team_ops", "Ops"]])}
      onPick={noop}
      pendingId={null}
    />
  );
  expect(html).toContain("Ruby");
  expect(html).toContain("Reviews vendor invoices");
  expect(html).toContain("In Ops");
  expect(html).toContain('type="button"');
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain("Adding...");
});

test("the picker skips the home team line when the team name is unknown", () => {
  const html = renderToStaticMarkup(
    <AddToTeamPicker
      candidates={[card("Ruby", { teamId: "team_gone" })]}
      error={null}
      homeTeamNames={new Map()}
      onPick={noop}
      pendingId={null}
    />
  );
  expect(html).not.toContain("In ");
});

test("the picker shows the empty message when there is no candidate", () => {
  const html = renderToStaticMarkup(
    <AddToTeamPicker
      candidates={[]}
      error={null}
      homeTeamNames={new Map()}
      onPick={noop}
      pendingId={null}
    />
  );
  expect(html).toContain("Every agent is already in this team.");
  expect(html).not.toContain("<ul");
});

test("the picker shows the error as an alert", () => {
  const html = renderToStaticMarkup(
    <AddToTeamPicker
      candidates={[card("Ruby")]}
      error="Could not add the agent."
      homeTeamNames={new Map()}
      onPick={noop}
      pendingId={null}
    />
  );
  expect(html).toContain('role="alert"');
  expect(html).toContain("Could not add the agent.");
});

test("while an add is pending the row says Adding... and every button is disabled", () => {
  const html = renderToStaticMarkup(
    <AddToTeamPicker
      candidates={[card("Ruby"), card("Milo")]}
      error={null}
      homeTeamNames={new Map()}
      onPick={noop}
      pendingId="ruby"
    />
  );
  expect(html).toContain("Adding...");
  expect(html.split('disabled=""').length - 1).toBe(2);
});
