import { describe, expect, test } from "bun:test";
import type { AgentInfo, McpPorts, RunInfo } from "../ports";
import { createHarbourmasterMcpServer, type ServerOptions } from "../server";
import { connectClient, textOf } from "../testing";

const LOCAL: AgentInfo = { id: "agt_1", name: "Ops Bot", slug: "ops-bot" };

const PEER: AgentInfo = {
  description: "Answers billing questions",
  host: "acme.example",
  id: "con_1",
  name: "Helper",
  peer: true,
  slug: "acme/helper",
};

const RUN: RunInfo = {
  agentId: "agt_1",
  answer: "42",
  error: null,
  runId: "run_1",
  sessionId: "ses_1",
  status: "done",
};

const PENDING_LOCAL: RunInfo = {
  ...RUN,
  answer: null,
  runId: "run_1",
  status: "running",
};

const WAITING_PEER: RunInfo = {
  ...RUN,
  answer: null,
  runId: "run_2",
  status: "waiting",
  statusText: "Waiting for a person to approve sending this message.",
};

/** Tool names that would add a peer connection, an invite or a pairing. */
const CONNECTION_LIKE = /connection|invite|pair/;

const uncalled = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`${name} should not be called`));

/** Stands in for an optional port so its tools register; every call rejects. */
const anyPort = <T>(): T =>
  new Proxy({}, { get: () => uncalled("optional port") }) as T;

/** Ports that answer what a test needs and reject any other call. */
const fakePorts = (overrides: Partial<McpPorts>): McpPorts => ({
  approveSkillVersion: uncalled("approveSkillVersion"),
  assignSkill: uncalled("assignSkill"),
  cancelRun: uncalled("cancelRun"),
  commitSkill: uncalled("commitSkill"),
  createRoutine: uncalled("createRoutine"),
  createSkill: uncalled("createSkill"),
  createTrigger: uncalled("createTrigger"),
  deleteRoutine: uncalled("deleteRoutine"),
  deleteSkill: uncalled("deleteSkill"),
  deleteTrigger: uncalled("deleteTrigger"),
  exportSkill: uncalled("exportSkill"),
  getRun: uncalled("getRun"),
  importSkill: uncalled("importSkill"),
  inboxList: uncalled("inboxList"),
  inboxPost: uncalled("inboxPost"),
  inboxRead: uncalled("inboxRead"),
  libraryBash: uncalled("libraryBash"),
  libraryList: uncalled("libraryList"),
  libraryRead: uncalled("libraryRead"),
  libraryVersions: uncalled("libraryVersions"),
  libraryWrite: uncalled("libraryWrite"),
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
  wikiRead: uncalled("wikiRead"),
  wikiSuggestEdit: uncalled("wikiSuggestEdit"),
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

describe("list_agents with peers", () => {
  test("gives a local agent only id, name and slug, and a peer its peer fields", async () => {
    const result = await callTool(
      fakePorts({ listAgents: () => Promise.resolve([LOCAL, PEER]) }),
      "list_agents",
      {}
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      agents: [
        { id: "agt_1", name: "Ops Bot", slug: "ops-bot" },
        {
          description: "Answers billing questions",
          host: "acme.example",
          id: "con_1",
          name: "Helper",
          peer: true,
          slug: "acme/helper",
        },
      ],
    });
    const lines = textOf(result).split("\n");
    expect(lines).toContain("ops-bot: Ops Bot");
    const peerLine = lines.find((line) => line.includes("acme/helper"));
    expect(peerLine).toBeDefined();
    expect(peerLine).toContain("acme.example");
    expect(peerLine).toContain("outside this workspace");
  });

  test("keeps the list unchanged when every agent is local", async () => {
    const result = await callTool(
      fakePorts({ listAgents: () => Promise.resolve([LOCAL]) }),
      "list_agents",
      {}
    );
    expect(result.structuredContent).toEqual({
      agents: [{ id: "agt_1", name: "Ops Bot", slug: "ops-bot" }],
    });
    expect(textOf(result)).toBe("ops-bot: Ops Bot");
  });
});

describe("send_message to a peer", () => {
  test("passes the peer slug to the port and reads a waiting run as pending", async () => {
    const received: unknown[] = [];
    const result = await callTool(
      fakePorts({
        sendMessage: (input) => {
          received.push(input);
          return Promise.resolve(WAITING_PEER);
        },
      }),
      "send_message",
      { agent: "acme/helper", text: "hi" }
    );
    expect(received).toEqual([{ agent: "acme/helper", text: "hi", waitMs: 0 }]);
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      runId: "run_2",
      state: "pending",
      status: "waiting",
    });
    const text = textOf(result);
    expect(text).toContain("run_2");
    expect(text).toContain(
      "Waiting for a person to approve sending this message."
    );
    expect(text).toContain("get_run");
  });

  test("reads a local pending run without a status text as before", async () => {
    const result = await callTool(
      fakePorts({ sendMessage: () => Promise.resolve(PENDING_LOCAL) }),
      "send_message",
      { agent: "ops-bot", text: "hi" }
    );
    expect(textOf(result)).toBe("Run run_1 is running. Check it with get_run.");
  });
});

describe("peer tool descriptions", () => {
  test("list_agents, send_message and get_run mention peers, and the first two say a person may approve", async () => {
    const { client, close } = await connectClient(
      createHarbourmasterMcpServer(fakePorts({}))
    );
    try {
      const { tools } = await client.listTools();
      const description = (name: string): string =>
        tools.find((tool) => tool.name === name)?.description ?? "";
      for (const name of ["list_agents", "send_message", "get_run"]) {
        expect(description(name)).toContain("peer");
      }
      for (const name of ["list_agents", "send_message"]) {
        expect(description(name)).toContain("approve");
      }
    } finally {
      await close();
    }
  });
});

describe("dry run with peers", () => {
  test("skips send_message to a peer without calling the port, and still runs get_run", async () => {
    const recorded: { tool: string }[] = [];
    const options: ServerOptions = {
      dryRun: {
        record: (skip) => {
          recorded.push(skip);
          return Promise.resolve();
        },
      },
    };
    const { client, close } = await connectClient(
      createHarbourmasterMcpServer(
        fakePorts({ getRun: () => Promise.resolve(RUN) }),
        options
      )
    );
    try {
      const sent = await client.callTool({
        arguments: { agent: "acme/helper", text: "hi" },
        name: "send_message",
      });
      expect(sent.structuredContent).toEqual({
        skipped: true,
        tool: "send_message",
      });
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.tool).toBe("send_message");

      const run = await client.callTool({
        arguments: { runId: "run_1" },
        name: "get_run",
      });
      expect(run.structuredContent).toMatchObject({
        answer: "42",
        state: "done",
      });
    } finally {
      await close();
    }
  });
});

describe("tool names with every optional feature on", () => {
  test("nobody should add a connection tool by accident: no name has connection, invite or pair", async () => {
    const { client, close } = await connectClient(
      createHarbourmasterMcpServer(
        {
          ...fakePorts({}),
          admin: anyPort(),
          artifacts: anyPort(),
          browser: anyPort(),
          computer: anyPort(),
          deck: anyPort(),
          deckCreation: anyPort(),
          live: anyPort(),
          mail: anyPort(),
          qa: anyPort(),
        },
        {
          admin: "admin",
          browser: true,
          computer: { desktop: true },
          mail: true,
          qa: true,
          readOnly: false,
        }
      )
    );
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names.length).toBeGreaterThan(20);
      for (const name of names) {
        expect(name.toLowerCase()).not.toMatch(CONNECTION_LIKE);
      }
    } finally {
      await close();
    }
  });
});
