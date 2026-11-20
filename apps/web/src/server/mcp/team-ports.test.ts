import { expect, test } from "bun:test";
import { ToolError } from "@repo/mcp/result";
import { ForbiddenError } from "@repo/services/authz";
import type { PostRecord, ThreadRecord } from "@repo/services/inbox";
import type {
  LeadMember,
  LeadService,
  ProposalRecord,
} from "@repo/services/teams/lead";
import type { Principal } from "@repo/services/workspaces";
import { createTeamPorts } from "./team-ports.ts";

type LeadFake = Pick<
  LeadService,
  "discussion" | "members" | "openTopic" | "post" | "proposeChange"
>;
interface Call {
  args: unknown[];
  method: string;
}

const lead: Principal = {
  agentId: "agent_lead",
  kind: "run",
  runId: "run_1",
  workspaceId: "ws_1",
};

const thread: ThreadRecord = {
  attentionClearedAt: null,
  createdAt: "2026-11-01T10:00:00.000Z",
  createdBy: "agent_lead",
  id: "thread_1",
  lastPostAt: "2026-11-01T10:05:00.000Z",
  teamId: "team_1",
  title: "Q4 plan",
};

const post: PostRecord = {
  artifacts: [],
  authorId: "agent_lead",
  authorKind: "agent",
  createdAt: "2026-11-01T10:06:00.000Z",
  fileIds: [],
  id: "post_1",
  runId: "run_1",
  text: "Hello team",
  threadId: "thread_1",
};

const proposal: ProposalRecord = {
  agentId: "agent_writer",
  field: "model",
  requestId: "req_1",
  status: "pending",
};

/** A lead service whose methods record their calls and return the given results. */
const recordingLead = (
  calls: Call[],
  results: { members: LeadMember[] }
): LeadFake => ({
  discussion: (...args) => {
    calls.push({ args, method: "discussion" });
    return Promise.resolve({ id: "discussion_1", round: 1, rounds: 3 });
  },
  members: (...args) => {
    calls.push({ args, method: "members" });
    return Promise.resolve(results.members);
  },
  openTopic: (...args) => {
    calls.push({ args, method: "openTopic" });
    return Promise.resolve(thread);
  },
  post: (...args) => {
    calls.push({ args, method: "post" });
    return Promise.resolve({ post, runs: [] });
  },
  proposeChange: (...args) => {
    calls.push({ args, method: "proposeChange" });
    return Promise.resolve(proposal);
  },
});

/** A service that refuses every caller, as the service does for a run that is not a lead. */
const refusingLead = (): LeadFake => {
  const refuse = () => Promise.reject(new ForbiddenError("teams.lead"));
  return {
    discussion: refuse,
    members: refuse,
    openTopic: refuse,
    post: refuse,
    proposeChange: refuse,
  };
};

test("members maps each member field by field and leaves out the optional fields it lacks", async () => {
  const calls: Call[] = [];
  const ports = createTeamPorts({
    principal: lead,
    services: {
      teamLead: recordingLead(calls, {
        members: [
          {
            contextBudget: "large",
            effort: "high",
            handle: "writer",
            id: "agent_writer",
            instructions: "Write clearly.",
            isLead: false,
            kind: "agent",
            model: "claude-sonnet",
            name: "Writer",
          },
          { id: "user_2", isLead: false, kind: "user", name: "Bo" },
        ],
      }),
    },
  });

  const members = await ports.members();

  expect(calls).toEqual([{ args: [lead], method: "members" }]);
  expect(members).toStrictEqual([
    {
      contextBudget: "large",
      effort: "high",
      handle: "writer",
      id: "agent_writer",
      instructions: "Write clearly.",
      isLead: false,
      kind: "agent",
      model: "claude-sonnet",
      name: "Writer",
    },
    { id: "user_2", isLead: false, kind: "user", name: "Bo" },
  ]);
});

test("openTopic passes the run and the input to the service and returns the thread's four fields", async () => {
  const calls: Call[] = [];
  const ports = createTeamPorts({
    principal: lead,
    services: { teamLead: recordingLead(calls, { members: [] }) },
  });
  const input = {
    members: [{ id: "user_2", kind: "user" as const }],
    title: "Q4 plan",
  };

  const opened = await ports.openTopic(input);

  expect(calls).toEqual([{ args: [lead, input], method: "openTopic" }]);
  expect(opened).toStrictEqual({
    createdAt: thread.createdAt,
    id: thread.id,
    lastPostAt: thread.lastPostAt,
    title: thread.title,
  });
});

test("post passes the run and the text and topic, and returns the post without storage fields", async () => {
  const calls: Call[] = [];
  const ports = createTeamPorts({
    principal: lead,
    services: { teamLead: recordingLead(calls, { members: [] }) },
  });

  const posted = await ports.post({ text: "Hello team", topic: "thread_1" });

  expect(calls).toEqual([
    { args: [lead, { text: "Hello team", topic: "thread_1" }], method: "post" },
  ]);
  expect(posted).toStrictEqual({
    post: {
      authorId: "agent_lead",
      authorKind: "agent",
      createdAt: "2026-11-01T10:06:00.000Z",
      id: "post_1",
      runId: "run_1",
      text: "Hello team",
    },
    runs: [],
  });
});

test("proposeChange passes the run and the proposal to the service and returns the pending request", async () => {
  const calls: Call[] = [];
  const ports = createTeamPorts({
    principal: lead,
    services: { teamLead: recordingLead(calls, { members: [] }) },
  });
  const input = {
    agentId: "agent_writer",
    field: "model" as const,
    reason: "Faster model for drafts",
    value: "claude-haiku",
  };

  const result = await ports.proposeChange(input);

  expect(calls).toEqual([{ args: [lead, input], method: "proposeChange" }]);
  expect(result).toStrictEqual({
    agentId: "agent_writer",
    field: "model",
    requestId: "req_1",
    status: "pending",
  });
});

test("a refusal from the service reaches the agent as a forbidden ToolError on every method", async () => {
  const ports = createTeamPorts({
    principal: lead,
    services: { teamLead: refusingLead() },
  });

  const calls = [
    () => ports.members(),
    () => ports.openTopic({ title: "Q4 plan" }),
    () => ports.post({ text: "Hello", topic: "thread_1" }),
    () =>
      ports.proposeChange({
        agentId: "agent_writer",
        field: "model",
        reason: "Faster",
        value: "claude-haiku",
      }),
  ];
  for (const call of calls) {
    // biome-ignore lint/performance/noAwaitInLoops: Each call is checked in turn.
    const error = await call().then(
      () => null,
      (failure: unknown) => failure
    );
    expect(error).toBeInstanceOf(ToolError);
    expect(error).toMatchObject({ code: "forbidden" });
  }
});

test("discussion forwards the authenticated principal and bounded round input", async () => {
  const calls: Call[] = [];
  const ports = createTeamPorts({
    principal: lead,
    services: { teamLead: recordingLead(calls, { members: [] }) },
  });
  const input = {
    question: "What should we do?",
    rounds: 3,
    topic: "thread_1",
  };
  expect(await ports.discussion(input)).toEqual({
    id: "discussion_1",
    round: 1,
    rounds: 3,
  });
  expect(calls).toEqual([{ args: [lead, input], method: "discussion" }]);
  const refused = createTeamPorts({
    principal: lead,
    services: { teamLead: refusingLead() },
  });
  await expect(refused.discussion(input)).rejects.toBeInstanceOf(ToolError);
});
