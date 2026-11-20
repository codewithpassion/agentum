import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { inboxThreads as inboxThreadRows } from "@repo/db/schema/inbox";
import { runRequests } from "@repo/db/schema/requests";
import {
  teamMembers as teamMemberRows,
  teams as teamRows,
} from "@repo/db/schema/teams";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "../agents.ts";
import { ForbiddenError } from "../authz.ts";
import { createEventsService } from "../events.ts";
import { createInboxService, type InboxService } from "../inbox.ts";
import { createRequestsService, type RequestsService } from "../requests.ts";
import type { Clock, RuntimeAdapter } from "../runs/types.ts";
import { createRunsService, type RunsService } from "../runs.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { createLeadService, type LeadService } from "./lead.ts";
import { PROPOSAL_FIELDS } from "./proposal.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";

const person = (userId: string, isAdmin?: boolean): Principal => ({
  ...(isAdmin ? { isAdmin } : {}),
  kind: "user",
  userId,
  via: "session",
  workspaceId: WORKSPACE,
});
const creator = person("u1");
const owner = person("u2");
const stranger = person("u3");
const admin = person("u4", true);

let db: ReturnType<typeof migrated>;
let agents: AgentsService;
let runs: RunsService;
let inbox: InboxService;
let requests: RequestsService;
let lead: LeadService;
let agentIds: Record<string, string>;
let teamId: string;
let threadId: string;

/** Every agent claims its run and never finishes it, so a run stays open for its tools. */
const openRuntime: RuntimeAdapter = {
  cancel: () => Promise.resolve(),
  dispatch: async (_db, run, _agent, deps) => {
    await deps.claimRun(SYSTEM_PRINCIPAL, run.id);
  },
  kind: "fake",
};

const id = (slug: string): string => {
  const found = agentIds[slug];
  if (!found) {
    throw new Error(`No agent ${slug}`);
  }
  return found;
};

const runPrincipal = (agentId: string, runId: string): Principal => ({
  agentId,
  kind: "run",
  runId,
  workspaceId: WORKSPACE,
});

/** The lead's run, woken by a person's post that names no agent. */
const leadRun = async (): Promise<Principal> => {
  const posted = await inbox.post(creator, { text: "plan?", threadId });
  const [woken] = posted.runs;
  if (!woken) {
    throw new Error("The lead was not woken");
  }
  return runPrincipal(woken.agentId, woken.runId);
};

/** A member's run, woken by a mention. */
const memberRun = async (slug: string): Promise<Principal> => {
  const posted = await inbox.post(creator, {
    text: `@${slug} hi`,
    threadId,
  });
  const [woken] = posted.runs;
  if (!woken) {
    throw new Error("The member was not woken");
  }
  return runPrincipal(woken.agentId, woken.runId);
};

const agentRow = async (slug: string) => await agents.get(creator, id(slug));

const pendingRequests = () =>
  db.select().from(runRequests).where(eq(runRequests.status, "pending")).all();

beforeEach(async () => {
  db = migrated();
  agentIds = {};
  const clock: Clock = {
    now: () => new Date(START),
    sleep: () => Promise.resolve(),
  };
  db.insert(workspaceRows)
    .values({
      clerkOrgId: "org_w1",
      createdAt: START,
      id: WORKSPACE,
      name: WORKSPACE,
      timezone: "UTC",
    })
    .run();
  const atomic = sqliteAtomic(db);
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  const events = createEventsService({ blobs, db });
  agents = createAgentsService({ db, events });
  inbox = createInboxService({
    atomic,
    clock,
    db,
    events,
    runs: { startRun: (principal, input) => runs.startRun(principal, input) },
  });
  runs = createRunsService({
    adapters: [openRuntime],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [inbox.gateway],
  });
  requests = createRequestsService({
    atomic,
    clock,
    db,
    events,
    runs,
    secrets: { maskerFor: () => Promise.resolve(null) },
  });
  lead = createLeadService({ agents, db, events, inbox, requests });
  for (const slug of ["maya", "scout", "other"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one agent at a time keeps the ids stable
    const agent = await agents.create(creator, {
      instructions: `You are ${slug}.`,
      model: "fake",
      name: slug,
      runtime: "fake",
      slug,
    });
    agentIds[slug] = agent.id;
  }
  // Scout is owned by u2, so u2 answers for it.
  db.update(agentRows)
    .set({ ownerUserId: "u2" })
    .where(eq(agentRows.id, id("scout")))
    .run();
  teamId = "team-1";
  db.insert(teamRows)
    .values({
      createdAt: START,
      id: teamId,
      leadAgentId: id("maya"),
      name: "Support",
      slug: "support",
      workspaceId: WORKSPACE,
    })
    .run();
  for (const memberId of [id("maya"), id("scout")]) {
    db.insert(teamMemberRows)
      .values({ memberId, memberKind: "agent", teamId, workspaceId: WORKSPACE })
      .run();
  }
  db.insert(teamMemberRows)
    .values({
      memberId: "u1",
      memberKind: "user",
      teamId,
      workspaceId: WORKSPACE,
    })
    .run();
  threadId = (await inbox.createThread(creator, { teamId, title: "Plans" })).id;
});

test("a run in its team room is the lead's room run", async () => {
  const principal = await leadRun();
  expect(await lead.roomRun(principal)).toEqual({
    teamId,
    teamName: "Support",
    threadId,
  });
});

test("every team operation refuses a non-lead", async () => {
  const member = await memberRun("scout");
  const calls = [
    () => lead.members(member),
    () => lead.post(member, { text: "hi", topic: threadId }),
    () => lead.openTopic(member, { title: "New" }),
    () =>
      lead.proposeChange(member, {
        agentId: id("scout"),
        field: "model",
        reason: "r",
        value: "fake",
      }),
  ];
  for (const call of calls) {
    // biome-ignore lint/performance/noAwaitInLoops: each refusal is checked in turn
    await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
  }
  expect(await lead.roomRun(member)).toBeNull();
  // A person is not a run.
  await expect(lead.members(creator)).rejects.toBeInstanceOf(ForbiddenError);
  expect(await lead.roomRun(creator)).toBeNull();
});

test("the lead in its own conversation is not in a room run", async () => {
  const started = await runs.startRun(creator, {
    agentId: id("maya"),
    input: { text: "hello" },
    session: { origin: "mcp" },
  });
  const principal = runPrincipal(id("maya"), started.runId);
  expect(await lead.roomRun(principal)).toBeNull();
  await expect(lead.members(principal)).rejects.toBeInstanceOf(ForbiddenError);
});

test("a lead in a team it does not lead is not restricted there", async () => {
  db.insert(teamRows)
    .values({
      createdAt: START,
      id: "team-2",
      leadAgentId: id("other"),
      name: "Other",
      slug: "other",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(teamMemberRows)
    .values({
      memberId: id("maya"),
      memberKind: "agent",
      teamId: "team-2",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(teamMemberRows)
    .values({
      memberId: "u1",
      memberKind: "user",
      teamId: "team-2",
      workspaceId: WORKSPACE,
    })
    .run();
  const otherThread = await inbox.createThread(creator, {
    teamId: "team-2",
    title: "Elsewhere",
  });
  const posted = await inbox.post(creator, {
    text: "@maya hi",
    threadId: otherThread.id,
  });
  const [woken] = posted.runs;
  if (!woken) {
    throw new Error("Maya was not woken");
  }
  const principal = runPrincipal(id("maya"), woken.runId);
  expect(await lead.roomRun(principal)).toBeNull();
});

test("members lists agents with their settings and people", async () => {
  const members = await lead.members(await leadRun());
  expect(members).toContainEqual({
    handle: "scout",
    id: id("scout"),
    instructions: "You are scout.",
    isLead: false,
    kind: "agent",
    model: "fake",
    name: "scout",
  });
  expect(members.find((member) => member.id === id("maya"))?.isLead).toBe(true);
  expect(members).toContainEqual({
    id: "u1",
    isLead: false,
    kind: "user",
    name: "u1",
  });
});

test("the lead posts to a topic of its team and opens a topic it is in", async () => {
  const principal = await leadRun();
  const posted = await lead.post(principal, {
    text: "update",
    topic: threadId,
  });
  expect(posted.post).toMatchObject({
    authorId: id("maya"),
    authorKind: "agent",
    text: "update",
  });
  const opened = await lead.openTopic(principal, {
    members: [{ id: id("scout"), kind: "agent" }],
    title: "Rollout",
  });
  const row = db
    .select()
    .from(inboxThreadRows)
    .where(eq(inboxThreadRows.id, opened.id))
    .get();
  expect(row).toMatchObject({
    createdBy: id("maya"),
    openedByAgentId: id("maya"),
    teamId,
    title: "Rollout",
  });
});

test("the lead cannot post to a topic of another team", async () => {
  const principal = await leadRun();
  const elsewhere = await inbox.createThread(creator, { title: "Everyone's" });
  await expect(
    lead.post(principal, { text: "x", topic: elsewhere.id })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("an agent opens a topic only in a team it leads", async () => {
  const principal = await runPrincipalFor("scout");
  await expect(
    inbox.createThread(principal, { teamId, title: "Mine" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    inbox.createThread(principal, { title: "No team" })
  ).rejects.toBeInstanceOf(ForbiddenError);
});

async function runPrincipalFor(slug: string): Promise<Principal> {
  return await memberRun(slug);
}

test("a proposal reaches the member's owner and nothing changes until they approve", async () => {
  const principal = await leadRun();
  const proposal = await lead.proposeChange(principal, {
    agentId: id("scout"),
    field: "instructions",
    reason: "Be shorter",
    value: "You are scout. Be brief.",
  });
  expect(proposal).toMatchObject({
    agentId: id("scout"),
    field: "instructions",
    status: "pending",
  });
  const [request] = pendingRequests();
  expect(request).toMatchObject({
    agentId: id("scout"),
    id: proposal.requestId,
    kind: "approval",
    toolName: "team_propose_change",
  });
  expect((await agentRow("scout")).instructions).toBe("You are scout.");
  // The lead's run is still open: the card outlives it and holds nothing back.
  const [listed] = await requests.listPending(owner);
  expect(listed?.id).toBe(proposal.requestId);
});

test("approving applies instructions, model, effort and context budget", async () => {
  const principal = await leadRun();
  const changes = [
    ["instructions", "You are scout. Be brief."],
    ["model", "fake-2"],
    ["effort", "high"],
    ["contextBudget", "large"],
  ] as const;
  for (const [field, value] of changes) {
    // biome-ignore lint/performance/noAwaitInLoops: each proposal is answered before the next
    const proposal = await lead.proposeChange(principal, {
      agentId: id("scout"),
      field,
      reason: "Because",
      value,
    });
    await requests.answer(owner, {
      answer: { decision: "allow_once" },
      requestId: proposal.requestId,
      via: "web",
    });
  }
  const scout = await agentRow("scout");
  expect(scout.instructions).toBe("You are scout. Be brief.");
  expect(scout.model).toBe("fake-2");
  expect(scout.runtimeConfig).toMatchObject({
    contextBudget: "large",
    effort: "high",
  });
});

test("rejecting a proposal leaves the member as it was", async () => {
  const principal = await leadRun();
  const proposal = await lead.proposeChange(principal, {
    agentId: id("scout"),
    field: "model",
    reason: "Cheaper",
    value: "fake-2",
  });
  await requests.answer(owner, {
    answer: { decision: "deny" },
    requestId: proposal.requestId,
    via: "web",
  });
  expect((await agentRow("scout")).model).toBe("fake");
});

test("only the member's owner or an admin answers a proposal, and never Always allow", async () => {
  const principal = await leadRun();
  const propose = () =>
    lead.proposeChange(principal, {
      agentId: id("scout"),
      field: "model",
      reason: "Cheaper",
      value: "fake-2",
    });
  const first = await propose();
  await expect(
    requests.answer(stranger, {
      answer: { decision: "allow_once" },
      requestId: first.requestId,
      via: "web",
    })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    requests.answer(owner, {
      answer: { decision: "always_allow" },
      requestId: first.requestId,
      via: "web",
    })
  ).rejects.toMatchObject({ code: "invalid" });
  expect((await agentRow("scout")).model).toBe("fake");
  await requests.answer(admin, {
    answer: { decision: "allow_once" },
    requestId: first.requestId,
    via: "web",
  });
  expect((await agentRow("scout")).model).toBe("fake-2");
});

test("access, keys, ask-before rules and connectors can never be proposed", async () => {
  const principal = await leadRun();
  expect([...PROPOSAL_FIELDS]).toEqual([
    "instructions",
    "model",
    "effort",
    "contextBudget",
  ]);
  for (const field of ["access", "keys", "askBefore", "connectors", "slug"]) {
    // biome-ignore lint/performance/noAwaitInLoops: each refusal is checked in turn
    await expect(
      lead.proposeChange(principal, {
        agentId: id("scout"),
        field,
        reason: "r",
        value: "x",
      } as never)
    ).rejects.toThrow();
  }
  expect(pendingRequests()).toEqual([]);
});

test("a proposal needs a member agent, a valid value and a card that fits", async () => {
  const principal = await leadRun();
  const base = { field: "effort", reason: "r", value: "high" } as const;
  await expect(
    lead.proposeChange(principal, { ...base, agentId: id("other") })
  ).rejects.toMatchObject({ code: "not_found" });
  await expect(
    lead.proposeChange(principal, {
      ...base,
      agentId: id("scout"),
      value: "extreme",
    })
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    lead.proposeChange(principal, {
      ...base,
      agentId: id("scout"),
      field: "instructions",
      value: "x".repeat(8000),
    })
  ).rejects.toMatchObject({ code: "invalid" });
  await expect(
    lead.proposeChange(principal, {
      ...base,
      agentId: id("scout"),
      field: "instructions",
      value: "Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 here",
    })
  ).rejects.toMatchObject({ code: "invalid" });
  expect(pendingRequests()).toEqual([]);
});

test("a proposal from a limited topic is refused when the member's owner is not in it", async () => {
  const limited = await inbox.createThread(creator, {
    members: [{ id: id("maya"), kind: "agent" }],
    teamId,
    title: "Private",
  });
  const posted = await inbox.post(creator, {
    text: "@maya hi",
    threadId: limited.id,
  });
  const [woken] = posted.runs;
  if (!woken) {
    throw new Error("Maya was not woken");
  }
  const principal = runPrincipal(id("maya"), woken.runId);
  await expect(
    lead.proposeChange(principal, {
      agentId: id("scout"),
      field: "model",
      reason: "r",
      value: "fake-2",
    })
  ).rejects.toMatchObject({ code: "invalid" });
  expect(pendingRequests()).toEqual([]);
});
