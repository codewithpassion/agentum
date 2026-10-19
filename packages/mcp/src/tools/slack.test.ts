import { describe, expect, test } from "bun:test";
import type { McpPorts, SlackDestinations, SlackSendResult } from "../ports";
import { ToolError } from "../result";
import { createHarbourmasterMcpServer } from "../server";
import { connectClient, textOf } from "../testing";

const DESTINATIONS: SlackDestinations = {
  channels: [
    { id: "C0123456789", isPrivate: false, name: "ops" },
    { id: "G0987654321", isPrivate: true, name: "leads" },
  ],
  people: [{ email: "ana@example.com", slackName: "Ana" }],
};

const SENT: SlackSendResult = {
  channel: "C0123456789",
  permalink: "https://example.slack.com/archives/C0123456789/p1",
  to: "#ops",
  ts: "1760000000.000100",
};

const uncalled = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`${name} should not be called`));

const fakePorts = (overrides: Partial<McpPorts> = {}): McpPorts => ({
  approveSkillVersion: uncalled("approveSkillVersion"),
  assignSkill: uncalled("assignSkill"),
  commitSkill: uncalled("commitSkill"),
  createRoutine: uncalled("createRoutine"),
  createSkill: uncalled("createSkill"),
  createTrigger: uncalled("createTrigger"),
  deleteRoutine: uncalled("deleteRoutine"),
  deleteTrigger: uncalled("deleteTrigger"),
  exportSkill: uncalled("exportSkill"),
  getRun: uncalled("getRun"),
  importSkill: uncalled("importSkill"),
  inboxList: uncalled("inboxList"),
  inboxPost: uncalled("inboxPost"),
  inboxRead: uncalled("inboxRead"),
  libraryBash: uncalled("libraryBash"),
  listAgents: uncalled("listAgents"),
  listRoutines: uncalled("listRoutines"),
  listSessions: uncalled("listSessions"),
  listSkills: uncalled("listSkills"),
  listTriggers: uncalled("listTriggers"),
  pinSkill: uncalled("pinSkill"),
  readSession: uncalled("readSession"),
  rejectSkillVersion: uncalled("rejectSkillVersion"),
  revertSkill: uncalled("revertSkill"),
  searchSessions: uncalled("searchSessions"),
  sendMessage: uncalled("sendMessage"),
  setRoutineEnabled: uncalled("setRoutineEnabled"),
  setTriggerEnabled: uncalled("setTriggerEnabled"),
  skillDiff: uncalled("skillDiff"),
  skillLog: uncalled("skillLog"),
  skillShow: uncalled("skillShow"),
  slackDestinations: uncalled("slackDestinations"),
  slackSend: uncalled("slackSend"),
  unassignSkill: uncalled("unassignSkill"),
  ...overrides,
});

const callTool = async (
  ports: McpPorts,
  name: string,
  args: Record<string, unknown>
) => {
  const { client, close } = await connectClient(
    createHarbourmasterMcpServer(ports)
  );
  try {
    return await client.callTool({ arguments: args, name });
  } finally {
    await close();
  }
};

describe("slack_destinations", () => {
  test("returns the destinations as data and one line per channel and person as text", async () => {
    const result = await callTool(
      fakePorts({ slackDestinations: () => Promise.resolve(DESTINATIONS) }),
      "slack_destinations",
      {}
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(DESTINATIONS);
    expect(textOf(result).split("\n")).toEqual([
      "#ops (C0123456789, public)",
      "#leads (G0987654321, private)",
      "ana@example.com as Ana",
    ]);
  });

  test("says there are no channels and no people when both lists are empty", async () => {
    const result = await callTool(
      fakePorts({
        slackDestinations: () => Promise.resolve({ channels: [], people: [] }),
      }),
      "slack_destinations",
      {}
    );
    expect(textOf(result).split("\n")).toEqual([
      "No channels. The Slack bot is in no channel yet. Ask a person to add it with /invite in a channel.",
      "No linked people.",
    ]);
  });
});

describe("slack_send", () => {
  test("passes to, text and thread_ts to the port and returns the channel, ts and permalink", async () => {
    const received: unknown[] = [];
    const result = await callTool(
      fakePorts({
        slackSend: (input) => {
          received.push(input);
          return Promise.resolve(SENT);
        },
      }),
      "slack_send",
      { text: "Deploy done", thread_ts: "1759999999.000100", to: "#ops" }
    );
    expect(received).toEqual([
      { text: "Deploy done", thread_ts: "1759999999.000100", to: "#ops" },
    ]);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(SENT);
    expect(textOf(result)).toBe(
      "Sent to #ops in C0123456789, ts 1760000000.000100. Link: https://example.slack.com/archives/C0123456789/p1"
    );
  });

  test("leaves the link out when Slack gave no permalink", async () => {
    const result = await callTool(
      fakePorts({
        slackSend: () => Promise.resolve({ ...SENT, permalink: null }),
      }),
      "slack_send",
      { text: "Deploy done", to: "#ops" }
    );
    expect(textOf(result)).toBe(
      "Sent to #ops in C0123456789, ts 1760000000.000100."
    );
  });

  test("refuses empty text without calling the port", async () => {
    const result = await callTool(fakePorts(), "slack_send", {
      text: "   ",
      to: "#ops",
    });
    expect(result.isError).toBe(true);
  });

  test("refuses an argument the schema does not declare without calling the port", async () => {
    const result = await callTool(fakePorts(), "slack_send", {
      text: "Deploy done",
      to: "#ops",
      unexpected: true,
    });
    expect(result.isError).toBe(true);
  });

  test("gives a ToolError from the port as an error result carrying its message", async () => {
    const result = await callTool(
      fakePorts({
        slackSend: () =>
          Promise.reject(
            new ToolError(
              "not_found",
              'The bot is not in "#nowhere". Pick one from slack_destinations.'
            )
          ),
      }),
      "slack_send",
      { text: "Deploy done", to: "#nowhere" }
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      'The bot is not in "#nowhere". Pick one from slack_destinations.'
    );
  });
});
