import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runRequests } from "@repo/db/schema/requests";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { eq } from "drizzle-orm";
import { ZodError } from "zod";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { createDeskService } from "./desk.ts";
import { createDeskApiService, type MemberDirectory } from "./desk-api.ts";
import { ServiceError } from "./errors.ts";
import { createEventsService } from "./events.ts";
import { createRequestsService } from "./requests.ts";
import type { RuntimeAdapter } from "./runs/types.ts";
import { createRunsService } from "./runs.ts";
import { type Principal, SYSTEM_PRINCIPAL as system } from "./workspaces.ts";

const user = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: "w1",
} as const;
const deskKey = {
  apiKey: { access: "desk", id: "k1" },
  kind: "user",
  userId: "key-minter",
  via: "api_key",
  workspaceId: "w1",
} as const;
const email = "dana@example.com";

let db: ReturnType<typeof migrated>;
let now: number;
let resumed: string[];
let requests: ReturnType<typeof createRequestsService>;
let runs: ReturnType<typeof createRunsService>;
let agents: AgentsService;
let agentId: string;
let events: ReturnType<typeof createEventsService>;
let directoryCalls: [string, string][];
let members: Map<string, string>;
let directory: MemberDirectory;
let desk: ReturnType<typeof createDeskApiService>;
let member: Extract<Principal, { kind: "user" }>;

beforeEach(async () => {
  db = migrated();
  now = Date.parse("2026-10-26T00:00:00Z");
  resumed = [];
  directoryCalls = [];
  members = new Map([[`${email}|org1`, "u1"]]);
  directory = (address, clerkOrgId) => {
    directoryCalls.push([address, clerkOrgId]);
    return Promise.resolve(members.get(`${address}|${clerkOrgId}`) ?? null);
  };
  await db.insert(workspaces).values([
    {
      clerkOrgId: "org1",
      createdAt: new Date(now).toISOString(),
      id: "w1",
      name: "Test",
      timezone: "UTC",
    },
    {
      clerkOrgId: "org2",
      createdAt: new Date(now).toISOString(),
      id: "w2",
      name: "Other",
      timezone: "UTC",
    },
  ]);
  const clock = {
    now: () => new Date(now),
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  events = createEventsService({ blobs, db });
  const adapter: RuntimeAdapter = {
    cancel: () => Promise.resolve(),
    dispatch: () => Promise.resolve(),
    kind: "cloud",
    resume: (_run, request) => {
      resumed.push(request.id);
      return Promise.resolve();
    },
  };
  runs = createRunsService({
    adapters: [adapter],
    atomic: sqliteAtomic(db),
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  agents = createAgentsService({ db, events });
  agentId = (
    await agents.create(user, { model: "m", name: "Cloud", runtime: "cloud" })
  ).id;
  requests = createRequestsService({
    atomic: sqliteAtomic(db),
    clock,
    db,
    events,
    runs,
    secrets: {
      maskerFor: () =>
        Promise.resolve(createMasker({ NAME: "granted-value-123" })),
    },
  });
  // Only `pendingRequests` is used here, so the other lanes' sources are empty.
  const none = () => Promise.resolve([]);
  const deskLanes = createDeskService({
    clock,
    db,
    inbox: { listThreads: none },
    requests,
    routines: { list: none },
    skillsStore: { proposals: none },
    triggers: { list: none },
  });
  desk = createDeskApiService({
    agents,
    db,
    desk: deskLanes,
    directory,
    requests,
    runs,
  });
  member = await desk.actingMember(deskKey, email);
  directoryCalls = [];
});

const start = async () => {
  const run = await runs.startRun(user, {
    agentId,
    input: { text: "go" },
    session: { origin: "ui" },
  });
  await runs.claimRun(system, run.runId);
  return run.runId;
};

const openBash = (runId: string, command: string, toolUseId = "call1") =>
  requests.open(system, {
    input: { command },
    kind: "approval",
    runId,
    toolKey: "bash",
    toolName: "bash",
    toolUseId,
  });

const openQuestion = (
  runId: string,
  questions: { choices?: string[]; header?: string; question: string }[],
  toolUseId = "q1"
) =>
  requests.open(system, {
    kind: "question",
    questions,
    runId,
    toolName: "ask_user",
    toolUseId,
  });

const requestRow = async (id: string) => {
  const [row] = await db
    .select()
    .from(runRequests)
    .where(eq(runRequests.id, id));
  if (!row) {
    throw new Error("Missing request ");
  }
  return row;
};

const runRow = async (id: string) => {
  const [row] = await db.select().from(runRows).where(eq(runRows.id, id));
  if (!row) {
    throw new Error("Missing run ");
  }
  return row;
};

test("a desk key acting for a member becomes that member, in the key's workspace", async () => {
  const acting = await desk.actingMember(deskKey, email);
  expect(acting).toEqual({ ...deskKey, userId: "u1" });
  expect(acting.userId).not.toBe(deskKey.userId);
  expect(acting.workspaceId).toBe("w1");
  expect(directoryCalls).toEqual([[email, "org1"]]);
});

test("actingMember refuses a desk key with no member, a blank or unknown member, and any other credential", async () => {
  await expect(desk.actingMember(deskKey, null)).rejects.toBeInstanceOf(
    ForbiddenError
  );
  await expect(desk.actingMember(deskKey, "   ")).rejects.toBeInstanceOf(
    ForbiddenError
  );
  await expect(
    desk.actingMember(deskKey, "stranger@example.com")
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    desk.actingMember(
      { ...deskKey, apiKey: { access: "read", id: "k1" } },
      email
    )
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    desk.actingMember(
      { ...deskKey, apiKey: { access: "write", id: "k1" } },
      email
    )
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    desk.actingMember({ ...deskKey, apiKey: undefined, via: "session" }, email)
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(
    desk.actingMember(
      { kind: "machine", machineId: "m1", workspaceId: "w1" },
      email
    )
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("an OAuth principal is refused, with or without an email", async () => {
  const oauth = {
    kind: "user",
    oauthClient: { access: "write", clientId: "c1" },
    userId: "u9",
    via: "oauth",
    workspaceId: "w1",
  } as const;
  await expect(desk.actingMember(oauth, email)).rejects.toBeInstanceOf(
    ForbiddenError
  );
  await expect(desk.actingMember(oauth, null)).rejects.toBeInstanceOf(
    ForbiddenError
  );
  expect(directoryCalls).toEqual([]);
});

test("needsYou lists a pending approval and question, and leaves out answered and expired requests", async () => {
  const runId = await start();
  const approval = await openBash(runId, "ls");
  const question = await openQuestion(runId, [
    { choices: ["D1", "Postgres"], header: "Store", question: "Which db?" },
  ]);
  expect(await desk.needsYou(member)).toEqual([
    {
      agent: "Cloud",
      createdAt: approval.createdAt,
      detail: JSON.stringify({ command: "ls" }, null, 2),
      expiresAt: approval.expiresAt,
      kind: "approval",
      requestId: approval.id,
      runId,
      title: "Run `ls`",
    },
    {
      agent: "Cloud",
      createdAt: question.createdAt,
      detail: "Which db? (D1 / Postgres)",
      expiresAt: question.expiresAt,
      kind: "question",
      requestId: question.id,
      runId,
      title: "Store",
    },
  ]);

  await desk.decide(member, approval.id, { decision: "allow_once" });
  expect((await desk.needsYou(member)).map((item) => item.requestId)).toEqual([
    question.id,
  ]);

  const late = await openBash(runId, "pwd", "late");
  now += 60 * 60_000 + 1;
  expect((await desk.needsYou(member)).map((item) => item.requestId)).toEqual([
    question.id,
  ]);
  expect((await requestRow(late.id)).status).toBe("pending");
});

test("needsYou shows a question without a header by its question text", async () => {
  const runId = await start();
  const question = await openQuestion(runId, [{ question: "Which region?" }]);
  expect(await desk.needsYou(member)).toEqual([
    expect.objectContaining({
      detail: "Which region?",
      requestId: question.id,
      title: "Which region?",
    }),
  ]);
});

test("needsYou shows the scrubbed input of an approval", async () => {
  const runId = await start();
  await openBash(runId, "echo sk-12345678901234567890");
  const [item] = await desk.needsYou(member);
  expect(item?.detail).toContain("[redacted]");
  expect(item?.detail).not.toContain("sk-12345678901234567890");
  expect(item?.title).not.toContain("sk-12345678901234567890");
});

test("deciding an approval records the decision, its note and who answered", async () => {
  const runId = await start();
  const allow = await openBash(runId, "ls", "allow");
  expect(
    await desk.decide(member, allow.id, { decision: "allow_once" })
  ).toEqual({ requestId: allow.id, status: "answered" });
  expect(await requests.outcome(system, allow.id)).toEqual({
    answer: { decision: "allow_once" },
    status: "answered",
  });
  const row = await requestRow(allow.id);
  expect(row.answeredBy).toBe("u1");
  expect(row.answeredVia).toBe("web");

  await requests.setRule(user, { agentId, mode: "ask", toolKey: "bash" });
  const always = await openBash(runId, "ls", "always");
  await desk.decide(member, always.id, { decision: "always" });
  expect(await requests.outcome(system, always.id)).toEqual({
    answer: { decision: "always_allow" },
    status: "answered",
  });
  expect(await requests.needsApproval(system, { runId, toolKey: "bash" })).toBe(
    false
  );

  const deny = await openBash(runId, "ls", "deny");
  await desk.decide(member, deny.id, { answer: "no", decision: "deny" });
  expect(await requests.outcome(system, deny.id)).toEqual({
    answer: { decision: "deny", note: "no" },
    status: "answered",
  });
});

test("deciding a question with an answer records it under the question text", async () => {
  const runId = await start();
  const blue = await openQuestion(runId, [{ question: "Colour?" }], "blue");
  await desk.decide(member, blue.id, {
    answer: "blue",
    decision: "allow_once",
  });
  expect(await requests.outcome(system, blue.id)).toEqual({
    answer: { answers: { "Colour?": "blue" } },
    status: "answered",
  });
});

test("deny on a question without an answer records Declined.", async () => {
  const runId = await start();
  const question = await openQuestion(runId, [{ question: "Colour?" }], "no");
  await desk.decide(member, question.id, { decision: "deny" });
  expect(await requests.outcome(system, question.id)).toEqual({
    answer: { answers: { "Colour?": "Declined." } },
    status: "answered",
  });
});

test("a question needs an answer unless denied, and a multi-question request is refused", async () => {
  const runId = await start();
  const single = await openQuestion(runId, [{ question: "Colour?" }], "single");
  await expect(
    desk.decide(member, single.id, { decision: "allow_once" })
  ).rejects.toMatchObject({ code: "invalid" });
  const several = await openQuestion(
    runId,
    [{ question: "Colour?" }, { question: "Size?" }],
    "several"
  );
  await expect(
    desk.decide(member, several.id, { answer: "blue", decision: "allow_once" })
  ).rejects.toMatchObject({ code: "invalid" });
  expect(await requests.outcome(system, several.id)).toBeNull();
});

test("deciding an unknown request, or one in another workspace, is not found", async () => {
  const runId = await start();
  const request = await openBash(runId, "ls");
  await expect(
    desk.decide(member, "missing", { decision: "allow_once" })
  ).rejects.toMatchObject({ code: "not_found" });
  const otherWorkspace = { ...member, workspaceId: "w2" };
  await expect(
    desk.decide(otherWorkspace, request.id, { decision: "allow_once" })
  ).rejects.toMatchObject({ code: "not_found" });
  expect(await requests.outcome(system, request.id)).toBeNull();
});

test("a second decision on a request is a conflict", async () => {
  const runId = await start();
  const request = await openBash(runId, "ls");
  await desk.decide(member, request.id, { decision: "allow_once" });
  await expect(
    desk.decide(member, request.id, { decision: "allow_once" })
  ).rejects.toMatchObject({ code: "conflict", message: "Already answered" });
});

test("a desk decision and a Slack answer at once leave one winner and resume once", async () => {
  const runId = await start();
  const request = await openBash(runId, "ls");
  const results = await Promise.allSettled([
    desk.decide(member, request.id, { decision: "allow_once" }),
    requests.answer(member, {
      answer: { decision: "deny" },
      requestId: request.id,
      via: "slack",
    }),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect(rejected[0]?.reason).toBeInstanceOf(ServiceError);
  expect(rejected[0]?.reason).toMatchObject({ code: "conflict" });
  expect(resumed).toEqual([request.id]);
});

test("a read-only key cannot decide a request", async () => {
  const runId = await start();
  const request = await openBash(runId, "ls");
  const readOnly = { ...member, apiKey: { access: "read", id: "k" } } as const;
  await expect(
    desk.decide(readOnly, request.id, { decision: "allow_once" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  expect(await requests.outcome(system, request.id)).toBeNull();
});

test("sendToController starts a run on the controller agent with the text", async () => {
  const controllerId = (
    await agents.create(user, {
      model: "m",
      name: "Controller",
      runtime: "cloud",
    })
  ).id;
  const sent = await desk.sendToController(member, { text: "status please" });
  const row = await runRow(sent.runId);
  expect(row.agentId).toBe(controllerId);
  expect(row.inputText).toBe("status please");
  expect(sent.sessionId).toBe(row.sessionId);
});

test("sendToController reuses the session for a threadId and starts a new one without it", async () => {
  await agents.create(user, {
    model: "m",
    name: "Controller",
    runtime: "cloud",
  });
  const first = await desk.sendToController(member, {
    text: "one",
    threadId: "t1",
  });
  const second = await desk.sendToController(member, {
    text: "two",
    threadId: "t1",
  });
  expect(second.sessionId).toBe(first.sessionId);
  const loose = await desk.sendToController(member, { text: "three" });
  const looseAgain = await desk.sendToController(member, { text: "four" });
  expect(loose.sessionId).not.toBe(looseAgain.sessionId);
});

test("sendToController needs an active controller agent", async () => {
  await expect(
    desk.sendToController(member, { text: "hello" })
  ).rejects.toMatchObject({ code: "not_found" });

  const controllerId = (
    await agents.create(user, {
      model: "m",
      name: "Controller",
      runtime: "cloud",
    })
  ).id;
  await agents.archive(user, controllerId);
  await expect(
    desk.sendToController(member, { text: "hello" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("sendToController refuses empty text and a read-only key", async () => {
  await agents.create(user, {
    model: "m",
    name: "Controller",
    runtime: "cloud",
  });
  await expect(
    desk.sendToController(member, { text: "" })
  ).rejects.toBeInstanceOf(ZodError);
  const readOnly = { ...member, apiKey: { access: "read", id: "k" } } as const;
  await expect(
    desk.sendToController(readOnly, { text: "hello" })
  ).rejects.toBeInstanceOf(ForbiddenError);
});

test("decide on a request in another member's private session is not found, whatever the body", async () => {
  const question = await openQuestion(await start(), [
    { question: "Which db?" },
  ]);
  members.set("eli@example.com|org1", "u2");
  const other = await desk.actingMember(deskKey, "eli@example.com");

  await expect(
    desk.decide(other, question.id, { decision: "allow_once" })
  ).rejects.toMatchObject({ code: "not_found" });
});

test("canSeeRun admits the opener's ui run and hides it from other members and unknown runs", async () => {
  const runId = await start();
  members.set("eli@example.com|org1", "u2");
  const other = await desk.actingMember(deskKey, "eli@example.com");

  expect(await desk.canSeeRun(member, runId)).toBe(true);
  expect(await desk.canSeeRun(other, runId)).toBe(false);
  expect(await desk.canSeeRun(member, "no-such-run")).toBe(false);
});
