import { expect, test } from "bun:test";
import type { Team } from "@repo/db/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { AddAgentForm } from "./add-agent-dialog.tsx";
import type { TeamAgent } from "./team-logic.ts";

const agent = (name: string, id: string): TeamAgent => ({
  avatar: { color: "teal", glyph: name.charAt(0) },
  id,
  jobLine: "",
  name,
});

const team = (memberIds: readonly string[]): Team => ({
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  folderPath: null,
  id: "team_ops",
  leadAgentId: null,
  leadListens: false,
  members: memberIds.map((memberId) => ({
    isHome: true,
    memberId,
    memberKind: "agent",
    teamId: "team_ops",
  })),
  name: "Ops",
  ownerUserId: null,
  rules: "",
  slug: "ops",
});

const noop = async (): Promise<void> => undefined;

const render = (agents: readonly TeamAgent[], current: Team) =>
  renderToStaticMarkup(
    <AddAgentForm agents={agents} onAdd={noop} team={current} />
  );

const OPTION = /<option [^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g;

test("lists only agents not in the team, by name", () => {
  const html = render(
    [
      agent("Zed", "agent_zed"),
      agent("Ruby", "agent_ruby"),
      agent("Milo", "agent_milo"),
    ],
    team(["agent_ruby"])
  );
  const options = [...html.matchAll(OPTION)].map((match) => [
    match[1],
    match[2],
  ]);
  expect(options).toEqual([
    ["", "Choose an agent"],
    ["agent_milo", "Milo"],
    ["agent_zed", "Zed"],
  ]);
  expect(html).toContain("Add an agent");
});

test("says every agent is in the team when none are left", () => {
  const html = render([agent("Ruby", "agent_ruby")], team(["agent_ruby"]));
  expect(html).toContain("Every agent is already in this team.");
  expect(html).not.toContain("<select");
  expect(html).not.toContain('role="alert"');
});
