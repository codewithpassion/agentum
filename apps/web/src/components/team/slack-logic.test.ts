import { expect, test } from "bun:test";
import type { TeamSlackStatus } from "@repo/db/shared";
import { channelLabel, missingSlackApps } from "./slack-logic.ts";
import { type TeamAgent, UNKNOWN_AGENT } from "./team-logic.ts";

type SlackApps = TeamSlackStatus["apps"];

const agent = (id: string, name: string): TeamAgent => ({
  avatar: { color: "slate", glyph: name.charAt(0) },
  id,
  jobLine: `${name} job`,
  name,
});

const AGENTS: TeamAgent[] = [
  agent("agent-1", "Sales Scout"),
  agent("agent-2", "Ops Desk"),
];

test("missingSlackApps leaves out an app that is in the channel", () => {
  const apps: SlackApps = [
    { agentId: "agent-1", botUserId: "UBOT1", inChannel: true },
  ];
  expect(missingSlackApps(apps, AGENTS)).toEqual([]);
});

test("missingSlackApps gives an app outside the channel its invite line", () => {
  const apps: SlackApps = [
    { agentId: "agent-1", botUserId: "UBOT1", inChannel: false },
  ];
  expect(missingSlackApps(apps, AGENTS)).toEqual([
    {
      agentId: "agent-1",
      invite: "/invite @sales-scout",
      name: "Sales Scout",
    },
  ]);
});

test("missingSlackApps gives a null invite when the agent has no Slack app", () => {
  const apps: SlackApps = [
    { agentId: "agent-2", botUserId: null, inChannel: false },
  ];
  expect(missingSlackApps(apps, AGENTS)).toEqual([
    { agentId: "agent-2", invite: null, name: "Ops Desk" },
  ]);
});

test("missingSlackApps names an unknown agent UNKNOWN_AGENT", () => {
  const apps: SlackApps = [
    { agentId: "agent-gone", botUserId: "UBOT9", inChannel: false },
  ];
  const [missing] = missingSlackApps(apps, AGENTS);
  expect(missing?.name).toBe(UNKNOWN_AGENT);
  expect(missing?.name).toBe("Unknown agent");
  expect(missing?.invite).toBe("/invite @unknown-agent");
});

test("missingSlackApps keeps the order of the apps", () => {
  const apps: SlackApps = [
    { agentId: "agent-2", botUserId: "UBOT2", inChannel: false },
    { agentId: "agent-1", botUserId: "UBOT1", inChannel: true },
    { agentId: "agent-3", botUserId: null, inChannel: false },
    { agentId: "agent-1", botUserId: "UBOT1", inChannel: false },
  ];
  const agents = [...AGENTS, agent("agent-3", "Archive")];
  expect(missingSlackApps(apps, agents).map((app) => app.agentId)).toEqual([
    "agent-2",
    "agent-3",
    "agent-1",
  ]);
});

test("missingSlackApps gives an empty list for no apps", () => {
  expect(missingSlackApps([], AGENTS)).toEqual([]);
});

test("channelLabel prefixes a channel name with a hash", () => {
  expect(channelLabel("ops", "C0123")).toBe("#ops");
});

test("channelLabel falls back to the channel id when there is no name", () => {
  expect(channelLabel(null, "C0123")).toBe("C0123");
  expect(channelLabel("", "C0123")).toBe("C0123");
});
