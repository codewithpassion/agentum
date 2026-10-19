import { describe, expect, test } from "bun:test";
import type {
  McpPorts,
  SlackDestinations,
  SlackHistory,
  SlackSearchResult,
  SlackSendResult,
} from "../ports";
import { ToolError } from "../result";
import { createHarbourmasterMcpServer } from "../server";
import { connectClient, textOf } from "../testing";

const DESTINATIONS: SlackDestinations = {
  channels: [
    {
      id: "C0123456789",
      isPrivate: false,
      mention: "<#C0123456789>",
      name: "ops",
    },
    {
      id: "G0987654321",
      isPrivate: true,
      mention: "<#G0987654321>",
      name: "leads",
    },
  ],
  people: [
    {
      email: "ana@example.com",
      mention: "<@U0456>",
      slackName: "Ana",
      slackUserId: "U0456",
    },
  ],
};

const SENT: SlackSendResult = {
  channel: "C0123456789",
  notes: [],
  permalink: "https://example.slack.com/archives/C0123456789/p1",
  to: "#ops",
  ts: "1760000000.000100",
};

const uncalled = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`${name} should not be called`));

const fakePorts = (overrides: Partial<McpPorts> = {}): McpPorts => ({
  approveSkillVersion: uncalled("approveSkillVersion"),
  assignSkill: uncalled("assignSkill"),
  cancelRun: uncalled("cancelRun"),
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
  slackHistory: uncalled("slackHistory"),
  slackSearch: uncalled("slackSearch"),
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
      "#ops (C0123456789, public), mention <#C0123456789>",
      "#leads (G0987654321, private), mention <#G0987654321>",
      "ana@example.com as Ana, mention <@U0456>",
    ]);
  });

  test("tells the agent to write a mention text, and says so in the tool description", async () => {
    const { client, close } = await connectClient(
      createHarbourmasterMcpServer(fakePorts())
    );
    try {
      const { tools } = await client.listTools();
      const tool = tools.find(
        (candidate) => candidate.name === "slack_destinations"
      );
      expect(tool?.description).toContain("<@U");
      expect(tool?.description).toContain("<#C");
    } finally {
      await close();
    }
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

const HISTORY: SlackHistory = {
  channel: "C0123456789",
  messages: [
    {
      author: "Ana",
      text: "Deploy is green",
      threadTs: null,
      time: "2026-10-18T09:00:00.000Z",
      ts: "1760000000.000100",
    },
    {
      author: "Ben",
      text: "Thanks",
      threadTs: "1760000000.000100",
      time: "2026-10-18T09:05:00.000Z",
      ts: "1760000300.000200",
    },
  ],
  nextCursor: "dGhyZWFk",
};

const SEARCH: SlackSearchResult = {
  hits: [
    {
      author: "Ana",
      channel: "#ops",
      text: "deploy failed on staging",
      threadTs: null,
      time: "2026-10-18T10:00:00.000Z",
      ts: "1760003600.000100",
    },
    {
      author: "Ben",
      channel: "#ops",
      text: "deploy rolled back",
      threadTs: "1760000000.000100",
      time: "2026-10-18T09:30:00.000Z",
      ts: "1760001800.000100",
    },
  ],
};

describe("slack_history", () => {
  test("passes every field to the port unchanged and renders one line per message with the next cursor last", async () => {
    const received: unknown[] = [];
    const input = {
      channel: "#ops",
      cursor: "abc",
      limit: 50,
      since: "2026-10-18T00:00:00Z",
      thread_ts: "1760000000.000100",
      until: "2026-10-19T00:00:00+02:00",
    };
    const result = await callTool(
      fakePorts({
        slackHistory: (received_input) => {
          received.push(received_input);
          return Promise.resolve(HISTORY);
        },
      }),
      "slack_history",
      input
    );
    expect(received).toEqual([input]);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(HISTORY);
    expect(textOf(result).split("\n")).toEqual([
      "[2026-10-18T09:00:00.000Z] Ana (ts 1760000000.000100): Deploy is green",
      "[2026-10-18T09:05:00.000Z] Ben (ts 1760000300.000200, thread 1760000000.000100): Thanks",
      'More messages: pass cursor "dGhyZWFk".',
    ]);
  });

  test("says there are no messages when the result is empty", async () => {
    const result = await callTool(
      fakePorts({
        slackHistory: () =>
          Promise.resolve({
            channel: "C0123456789",
            messages: [],
            nextCursor: null,
          }),
      }),
      "slack_history",
      { channel: "#ops" }
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("No messages.");
  });

  test("gives a ToolError from the port as an error result carrying its message", async () => {
    const result = await callTool(
      fakePorts({
        slackHistory: () =>
          Promise.reject(
            new ToolError(
              "not_found",
              'The bot is not in "#nowhere". Pick one from slack_destinations.'
            )
          ),
      }),
      "slack_history",
      { channel: "#nowhere" }
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      'The bot is not in "#nowhere". Pick one from slack_destinations.'
    );
  });

  test("refuses a limit outside 1 to 200 without calling the port", async () => {
    const received: unknown[] = [];
    const ports = fakePorts({
      slackHistory: (input) => {
        received.push(input);
        return Promise.resolve(HISTORY);
      },
    });
    const results = await Promise.all(
      [0, 201].map((limit) =>
        callTool(ports, "slack_history", { channel: "#ops", limit })
      )
    );
    for (const result of results) {
      expect(result.isError).toBe(true);
    }
    expect(received).toEqual([]);
  });
});

describe("slack_search", () => {
  test("passes every field to the port unchanged and renders one line per hit", async () => {
    const received: unknown[] = [];
    const input = {
      channel: "#ops",
      limit: 10,
      person: "ana@example.com",
      query: "deploy",
      since: "2026-10-18T00:00:00Z",
      until: "2026-10-19T00:00:00+02:00",
    };
    const result = await callTool(
      fakePorts({
        slackSearch: (received_input) => {
          received.push(received_input);
          return Promise.resolve(SEARCH);
        },
      }),
      "slack_search",
      input
    );
    expect(received).toEqual([input]);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(SEARCH);
    expect(textOf(result).split("\n")).toEqual([
      "[2026-10-18T10:00:00.000Z] Ana in #ops (ts 1760003600.000100): deploy failed on staging",
      "[2026-10-18T09:30:00.000Z] Ben in #ops (ts 1760001800.000100, thread 1760000000.000100): deploy rolled back",
    ]);
  });

  test("says there are no matches when the search finds nothing", async () => {
    const result = await callTool(
      fakePorts({
        slackSearch: () => Promise.resolve({ hits: [] }),
      }),
      "slack_search",
      { query: "deploy" }
    );
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe("No matches.");
  });

  test("gives a ToolError from the port as an error result carrying its message", async () => {
    const result = await callTool(
      fakePorts({
        slackSearch: () =>
          Promise.reject(
            new ToolError("forbidden", "Search is off for this agent.")
          ),
      }),
      "slack_search",
      { query: "deploy" }
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Search is off for this agent.");
  });

  test("refuses an empty query and a limit above 50 without calling the port", async () => {
    const received: unknown[] = [];
    const ports = fakePorts({
      slackSearch: (input) => {
        received.push(input);
        return Promise.resolve({ hits: [] });
      },
    });
    const empty = await callTool(ports, "slack_search", { query: "" });
    const tooMany = await callTool(ports, "slack_search", {
      limit: 51,
      query: "deploy",
    });
    expect(empty.isError).toBe(true);
    expect(tooMany.isError).toBe(true);
    expect(received).toEqual([]);
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

  test("puts each note on its own line after the sent line", async () => {
    const result = await callTool(
      fakePorts({
        slackSend: () =>
          Promise.resolve({
            ...SENT,
            notes: [
              "@ana was sent as plain text: no linked person matches it.",
              "@here was sent as plain text.",
            ],
          }),
      }),
      "slack_send",
      { text: "@ana @here Deploy done", to: "#ops" }
    );
    expect(textOf(result).split("\n")).toEqual([
      "Sent to #ops in C0123456789, ts 1760000000.000100. Link: https://example.slack.com/archives/C0123456789/p1",
      "@ana was sent as plain text: no linked person matches it.",
      "@here was sent as plain text.",
    ]);
  });

  test("describes the mention syntax in the tool description and the text field", async () => {
    const { client, close } = await connectClient(
      createHarbourmasterMcpServer(fakePorts())
    );
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((candidate) => candidate.name === "slack_send");
      if (!tool) {
        throw new Error("slack_send is not listed");
      }
      expect(tool.description).toContain("<@U");
      expect(tool.description).toContain("@here and @channel");
      const schema = tool.inputSchema as {
        properties: { text?: { description?: string } };
      };
      expect(schema.properties.text?.description).toBe(
        "The message to send. Mention a person with <@U…> or @name, as the tool description says."
      );
    } finally {
      await close();
    }
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
