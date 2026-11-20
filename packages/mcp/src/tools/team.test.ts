import { describe, expect, test } from "bun:test";
import type {
  AdminPort,
  PostedInfo,
  QaPort,
  SubagentsPort,
  TeamMemberInfo,
  TeamPort,
  TeamProposalInfo,
  ThreadInfo,
} from "../ports";
import { agentumTools, createAgentumMcpServer } from "../server";
import { connectClient, textOf } from "../testing";
import { READ_ONLY, WRITE_CREATE } from "./define";
import { callTool, fakePorts } from "./library-wiki.test-helpers";

const TEAM_NAMES = [
  "team_discussion",
  "team_members",
  "team_post",
  "team_open_topic",
  "team_propose_change",
];
const ROOM_OPTIONS = {
  admin: "admin",
  qa: true,
  subagents: { start: true },
  teamRoom: true,
} as const;
const WRITE_NAMES = [
  "inbox_post",
  "bash",
  "library_write",
  "create_routine",
  "start_subagent",
  "qa_ask",
  "create_agent",
];

const fail = (): Promise<never> =>
  Promise.reject(new Error("Unexpected port call"));

const teamPort = (overrides: Partial<TeamPort> = {}): TeamPort => ({
  discussion: fail,
  members: fail,
  openTopic: fail,
  post: fail,
  proposeChange: fail,
  ...overrides,
});

const adminPort = (): AdminPort => ({
  archiveAgent: fail,
  checkAgentAddress: fail,
  createAgent: fail,
  createApiKey: fail,
  createEnrolmentCode: fail,
  createInboxThread: fail,
  createSecret: fail,
  deleteConnector: fail,
  getAgent: fail,
  grantSecret: fail,
  reserveAgentAddress: fail,
  restoreAgent: fail,
  revokeApiKey: fail,
  revokeSecret: fail,
  setAgentAskBefore: fail,
  setAgentOwners: fail,
  updateAgent: fail,
});

const subagentsPort = (): SubagentsPort => ({
  list: fail,
  message: fail,
  start: fail,
  status: fail,
  stop: fail,
});

/** Every port a room run could reach, so each group is registered. */
const allPorts = () =>
  fakePorts({
    admin: adminPort(),
    qa: qaPort(),
    subagents: subagentsPort(),
    team: teamPort(),
  });

const qaPort = (): QaPort => ({
  answer: fail,
  ask: fail,
  get: fail,
  list: fail,
});

const LEAD: TeamMemberInfo = {
  contextBudget: "standard",
  effort: "high",
  handle: "lead",
  id: "agent-lead",
  instructions: "Coordinate the team.",
  isLead: true,
  kind: "agent",
  model: "claude-a",
  name: "Lead",
};
const PERSON: TeamMemberInfo = {
  handle: "dom",
  id: "user-dom",
  isLead: false,
  kind: "user",
  name: "Dom",
};
const TOPIC: ThreadInfo = {
  createdAt: "2026-11-20T00:00:00Z",
  id: "topic-1",
  lastPostAt: "2026-11-20T00:00:00Z",
  title: "Plan",
};
const POST: PostedInfo["post"] = {
  authorId: "agent-lead",
  authorKind: "agent",
  createdAt: "2026-11-20T00:00:00Z",
  id: "post-1",
  runId: "run-0",
  text: "Hello",
};
const PROPOSAL: TeamProposalInfo = {
  agentId: "agent-member",
  field: "model",
  requestId: "request-1",
  status: "pending",
};

const teamNamesOf = (list: readonly { name: string }[]) =>
  list.map((tool) => tool.name).filter((name) => TEAM_NAMES.includes(name));

describe("team registration", () => {
  test("offers no team tool without the room option, even with the port", () => {
    expect(teamNamesOf(agentumTools(fakePorts({ team: teamPort() })))).toEqual(
      []
    );
    expect(
      teamNamesOf(
        agentumTools(fakePorts({ team: teamPort() }), { teamRoom: false })
      )
    ).toEqual([]);
  });

  test("offers no team tool in a room run without the port", () => {
    expect(teamNamesOf(agentumTools(fakePorts(), { teamRoom: true }))).toEqual(
      []
    );
  });

  test("a room run keeps only the team tools, reads and send_message", () => {
    const list = agentumTools(allPorts(), ROOM_OPTIONS);
    const team = list.filter((tool) => TEAM_NAMES.includes(tool.name));
    expect(team.map((tool) => tool.name).sort()).toEqual(
      [...TEAM_NAMES].sort()
    );
    for (const tool of list) {
      if (TEAM_NAMES.includes(tool.name)) {
        continue;
      }
      expect(
        tool.annotations.readOnlyHint === true || tool.name === "send_message"
      ).toBe(true);
    }
    const names = list.map((tool) => tool.name);
    expect(names).toContain("send_message");
    expect(names).toContain("get_run");
    for (const name of WRITE_NAMES) {
      expect(names).not.toContain(name);
    }
  });

  test("the write tools the room run cuts exist outside a room run", () => {
    const names = agentumTools(allPorts(), {
      ...ROOM_OPTIONS,
      teamRoom: false,
    }).map((tool) => tool.name);
    for (const name of WRITE_NAMES) {
      expect(names).toContain(name);
    }
  });

  test("advertises the team tools with their annotations", async () => {
    const { client, close } = await connectClient(
      createAgentumMcpServer(fakePorts({ team: teamPort() }), {
        teamRoom: true,
      })
    );
    try {
      const { tools } = await client.listTools();
      const team = tools.filter((tool) => tool.name.startsWith("team_"));
      expect(team.map((tool) => tool.name).sort()).toEqual(
        [...TEAM_NAMES].sort()
      );
      for (const tool of team) {
        expect(tool.annotations).toEqual(
          tool.name === "team_members" ? READ_ONLY : WRITE_CREATE
        );
      }
    } finally {
      await close();
    }
  });
});

describe("team tool results", () => {
  test("team_members returns the members with their full instructions", async () => {
    const result = await callTool(
      fakePorts({
        team: teamPort({ members: () => Promise.resolve([LEAD, PERSON]) }),
      }),
      "team_members",
      {},
      { teamRoom: true }
    );
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ members: [LEAD, PERSON] });
    expect(textOf(result)).toContain(
      "agent agent-lead @lead Lead (lead) model=claude-a effort=high contextBudget=standard"
    );
    expect(textOf(result)).toContain("user user-dom @dom Dom");
  });

  test("team_post sends the trimmed text and reports the started runs", async () => {
    const received: unknown[] = [];
    const ports = fakePorts({
      team: teamPort({
        post: (input) => {
          received.push(input);
          return Promise.resolve({
            post: POST,
            runs: [{ agentId: "agent-member", runId: "run-1" }],
          });
        },
      }),
    });
    const result = await callTool(
      ports,
      "team_post",
      { text: "  Hi @member  ", topic: "topic-1" },
      { teamRoom: true }
    );
    expect(received).toEqual([{ text: "Hi @member", topic: "topic-1" }]);
    expect(textOf(result)).toBe(
      "Posted post-1. Started runs: agent-member=run-1"
    );
    expect(result.structuredContent).toEqual({
      post: POST,
      runs: [{ agentId: "agent-member", runId: "run-1" }],
    });
  });

  test("team_post says when no run started", async () => {
    const result = await callTool(
      fakePorts({
        team: teamPort({
          post: () => Promise.resolve({ post: POST, runs: [] }),
        }),
      }),
      "team_post",
      { text: "No mentions", topic: "topic-1" },
      { teamRoom: true }
    );
    expect(textOf(result)).toBe("Posted post-1. Started no runs.");
  });

  test("team_open_topic passes the trimmed title and the members", async () => {
    const received: unknown[] = [];
    const ports = fakePorts({
      team: teamPort({
        openTopic: (input) => {
          received.push(input);
          return Promise.resolve(TOPIC);
        },
      }),
    });
    const members = [{ id: "user-dom", kind: "user" }];
    const limited = await callTool(
      ports,
      "team_open_topic",
      { members, title: "  Plan " },
      { teamRoom: true }
    );
    const open = await callTool(
      ports,
      "team_open_topic",
      { title: "Plan" },
      { teamRoom: true }
    );
    expect(received).toEqual([{ members, title: "Plan" }, { title: "Plan" }]);
    expect(textOf(limited)).toBe("Opened topic topic-1: Plan");
    expect(limited.structuredContent).toEqual(TOPIC);
    expect(textOf(open)).toBe("Opened topic topic-1: Plan");
  });

  test("team_propose_change passes the proposal and reports the approval request", async () => {
    const received: unknown[] = [];
    const ports = fakePorts({
      team: teamPort({
        proposeChange: (input) => {
          received.push(input);
          return Promise.resolve(PROPOSAL);
        },
      }),
    });
    const result = await callTool(
      ports,
      "team_propose_change",
      {
        agentId: "agent-member",
        field: "model",
        reason: "  Cheaper for this work ",
        value: "claude-b",
      },
      { teamRoom: true }
    );
    expect(received).toEqual([
      {
        agentId: "agent-member",
        field: "model",
        reason: "Cheaper for this work",
        value: "claude-b",
      },
    ]);
    expect(textOf(result)).toBe(
      "Proposed changing model of agent-member. Its owner was asked (request request-1). Nothing changes until they approve."
    );
    expect(result.structuredContent).toEqual(PROPOSAL);
  });
});

describe("team tool validation", () => {
  test.each([["access"], ["keys"], ["askBefore"], ["connectors"]])(
    "refuses a proposal for field %s before calling the port",
    async (field) => {
      let calls = 0;
      const count = (): Promise<never> => {
        calls += 1;
        return fail();
      };
      const result = await callTool(
        fakePorts({ team: teamPort({ proposeChange: count }) }),
        "team_propose_change",
        { agentId: "agent-member", field, reason: "Why", value: "x" },
        { teamRoom: true }
      );
      expect(result.isError).toBe(true);
      expect(calls).toBe(0);
    }
  );

  test("refuses an unknown key before calling the port", async () => {
    let calls = 0;
    const count = (): Promise<never> => {
      calls += 1;
      return fail();
    };
    const result = await callTool(
      fakePorts({ team: teamPort({ proposeChange: count }) }),
      "team_propose_change",
      {
        agentId: "agent-member",
        extra: true,
        field: "model",
        reason: "Why",
        value: "x",
      },
      { teamRoom: true }
    );
    expect(result.isError).toBe(true);
    expect(calls).toBe(0);
  });
});

test("team_discussion passes topic, trimmed question and rounds", async () => {
  const received: unknown[] = [];
  const result = await callTool(
    fakePorts({
      team: teamPort({
        discussion: (input) => {
          received.push(input);
          return Promise.resolve({ id: "discussion-1", round: 1, rounds: 3 });
        },
      }),
    }),
    "team_discussion",
    { question: "  Why?  ", rounds: 3, topic: "topic-1" },
    { teamRoom: true }
  );
  expect(result.isError).toBeFalsy();
  expect(received).toEqual([{ question: "Why?", rounds: 3, topic: "topic-1" }]);
});

test.each([0, 6, 1.5])("team_discussion refuses rounds %s", async (rounds) => {
  const result = await callTool(
    fakePorts({ team: teamPort() }),
    "team_discussion",
    { question: "Why?", rounds, topic: "topic-1" },
    { teamRoom: true }
  );
  expect(result.isError).toBe(true);
});
