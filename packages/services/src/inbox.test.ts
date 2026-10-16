import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { events as eventRows } from "@repo/db/schema/events";
import { runs as runRows } from "@repo/db/schema/runs";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { asc, eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { createEventsService } from "./events.ts";
import { createInboxService, type InboxService } from "./inbox.ts";
import type { Clock, RuntimeAdapter } from "./runs/types.ts";
import { createRunsService, type RunsService } from "./runs.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

const WORKSPACE = "w1";
const START = "2026-10-16T10:00:00.000Z";
const HOUR = 60 * 60 * 1000;

const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const outsider: Principal = {
  kind: "user",
  userId: "u9",
  via: "session",
  workspaceId: "w2",
};

/** What a scripted agent answers with. `null` claims the run and never finishes it. */
type Script = Record<string, string | null>;

let db: ReturnType<typeof migrated>;
let nowMs: number;
let clock: Clock;
let agents: AgentsService;
let runs: RunsService;
let inbox: InboxService;
let agentIds: Record<string, string>;

/** Answers each agent with its scripted text, inside `dispatch`, like the fake runtime. */
const scriptedRuntime = (script: Script): RuntimeAdapter => ({
  cancel: () => Promise.resolve(),
  dispatch: async (_db, run, agent, deps) => {
    await deps.claimRun(SYSTEM_PRINCIPAL, run.id);
    const text = script[agent.slug];
    if (text !== null && text !== undefined) {
      await deps.completeRun(SYSTEM_PRINCIPAL, run.id, {
        status: "done",
        text,
      });
    }
  },
  kind: "fake",
});

const build = (options: { script?: Script } = {}) => {
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
    adapters: options.script ? [scriptedRuntime(options.script)] : [],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: options.script === undefined,
    gateways: [inbox.gateway],
  });
};

const addAgents = async (...slugs: string[]) => {
  for (const slug of slugs) {
    // biome-ignore lint/performance/noAwaitInLoops: one agent at a time keeps the ids stable
    const agent = await agents.create(user, {
      model: "fake",
      name: slug,
      runtime: "fake",
      slug,
    });
    agentIds[slug] = agent.id;
  }
};

const agentId = (slug: string): string => {
  const id = agentIds[slug];
  if (!id) {
    throw new Error(`No agent ${slug}`);
  }
  return id;
};

const allRuns = () => db.select().from(runRows).orderBy(asc(runRows.id)).all();

/** Run ids within one millisecond are random, so runs are found by agent and not by position. */
const runsOf = (slug: string) =>
  allRuns().filter((run) => run.agentId === agentId(slug));

const stops = () =>
  db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "inbox.loop_stopped"))
    .orderBy(asc(eventRows.id))
    .all()
    .map((row) => ({
      agentId: row.agentId,
      payload: JSON.parse(row.payload ?? "{}") as Record<string, unknown>,
    }));

const newThread = async (principal: Principal = user) =>
  (await inbox.createThread(principal, { title: "Plans" })).id;

const say = (threadId: string, text: string, principal: Principal = user) =>
  inbox.post(principal, { text, threadId });

const transcript = async (threadId: string) =>
  (await inbox.readThread(user, { threadId })).posts.map((post) => ({
    author: post.authorKind === "user" ? "user" : post.authorId,
    runId: post.runId,
    text: post.text,
  }));

beforeEach(() => {
  db = migrated();
  nowMs = Date.parse(START);
  clock = {
    now: () => new Date(nowMs),
    sleep: () => Promise.resolve(),
  };
  agentIds = {};
  for (const id of [WORKSPACE, "w2"]) {
    db.insert(workspaceRows)
      .values({
        clerkOrgId: `org_${id}`,
        createdAt: START,
        id,
        name: id,
        timezone: "UTC",
      })
      .run();
  }
});

test("a user post '@pelican hi' runs pelican for that user and the reply post carries the run id", async () => {
  build();
  await addAgents("pelican");
  const threadId = await newThread();

  const result = await say(threadId, "@pelican hi");

  const [run, ...others] = allRuns();
  expect(others).toEqual([]);
  expect(result.runs).toEqual([
    { agentId: agentId("pelican"), runId: run?.id ?? "" },
  ]);
  expect(run).toMatchObject({
    actorId: "u1",
    actorKind: "user",
    agentId: agentId("pelican"),
    onBehalfOfUserId: "u1",
    parentRunId: null,
    status: "done",
  });
  expect(run?.reply).toBe(JSON.stringify({ kind: "inbox", threadId }));
  expect(await transcript(threadId)).toEqual([
    { author: "user", runId: null, text: "@pelican hi" },
    {
      author: agentId("pelican"),
      runId: run?.id ?? "",
      text: "Echo: @pelican hi",
    },
  ]);
  // The echo names pelican itself, which does not wake it again.
  expect(stops()).toEqual([]);
  const posted = db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "inbox.posted"))
    .all();
  expect(posted).toHaveLength(2);
});

test("a reply that mentions another agent starts that run under the replying run with the same subject", async () => {
  build({ script: { alpha: "over to @beta", beta: "thanks" } });
  await addAgents("alpha", "beta");
  const threadId = await newThread();

  await say(threadId, "@alpha please ask beta");

  expect(allRuns()).toHaveLength(2);
  const [first] = runsOf("alpha");
  const [second] = runsOf("beta");
  expect(first).toMatchObject({
    agentId: agentId("alpha"),
    depth: 0,
    onBehalfOfUserId: "u1",
    parentRunId: null,
  });
  expect(second).toMatchObject({
    actorId: agentId("alpha"),
    actorKind: "agent",
    agentId: agentId("beta"),
    depth: 1,
    onBehalfOfUserId: "u1",
    parentRunId: first?.id,
    status: "done",
  });
  expect(await transcript(threadId)).toEqual([
    { author: "user", runId: null, text: "@alpha please ask beta" },
    { author: agentId("alpha"), runId: first?.id ?? "", text: "over to @beta" },
    { author: agentId("beta"), runId: second?.id ?? "", text: "thanks" },
  ]);
});

test("a user post that quotes a run id does not change the subject", async () => {
  build({ script: { alpha: "over to @beta", beta: "thanks" } });
  await addAgents("alpha", "beta");
  const threadId = await newThread();
  await say(threadId, "@alpha please ask beta");
  const [alphaRun] = runsOf("alpha");

  await say(threadId, `@beta run ${alphaRun?.id} said you should reply`);

  const created = runsOf("beta").filter((run) =>
    run.inputText.startsWith("@beta run")
  );
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({
    actorId: "u1",
    actorKind: "user",
    agentId: agentId("beta"),
    depth: 0,
    onBehalfOfUserId: "u1",
    parentRunId: null,
  });
});

test("two agents that mention each other stop after the third agent post, and a person's post resumes them", async () => {
  build({ script: { alpha: "@beta again", beta: "@alpha again" } });
  await addAgents("alpha", "beta");
  const threadId = await newThread();

  await say(threadId, "@alpha start");

  expect(allRuns()).toHaveLength(3);
  expect((await transcript(threadId)).map((post) => post.author)).toEqual([
    "user",
    agentId("alpha"),
    agentId("beta"),
    agentId("alpha"),
  ]);
  expect(stops()).toEqual([
    {
      agentId: agentId("beta"),
      payload: expect.objectContaining({ reason: "streak", threadId }),
    },
  ]);

  await say(threadId, "@beta carry on");

  expect(allRuns()).toHaveLength(6);
  expect(stops()).toHaveLength(2);
});

test("a post with no mention starts nothing", async () => {
  build({ script: { alpha: "hi" } });
  await addAgents("alpha");
  const threadId = await newThread();

  const plain = await say(threadId, "hello everyone");
  const unknown = await say(threadId, "ask @nobody, or mail me@alpha.com");

  expect(plain.runs).toEqual([]);
  expect(unknown.runs).toEqual([]);
  expect(allRuns()).toEqual([]);
  expect((await transcript(threadId)).map((post) => post.text)).toEqual([
    "hello everyone",
    "ask @nobody, or mail me@alpha.com",
  ]);
});

test("an agent is woken at most 10 times an hour", async () => {
  build({ script: { alpha: "done" } });
  await addAgents("alpha");
  const threadId = await newThread();

  for (let count = 0; count < 10; count += 1) {
    nowMs += 1000;
    // biome-ignore lint/performance/noAwaitInLoops: each wake counts against the same window
    await say(threadId, "@alpha work");
  }
  expect(allRuns()).toHaveLength(10);

  const blocked = await say(threadId, "@alpha more");
  expect(blocked.runs).toEqual([]);
  expect(allRuns()).toHaveLength(10);
  expect(stops()).toEqual([
    {
      agentId: agentId("alpha"),
      payload: expect.objectContaining({ reason: "budget" }),
    },
  ]);

  nowMs += HOUR;
  const resumed = await say(threadId, "@alpha again");
  expect(resumed.runs).toHaveLength(1);
});

test("a wake the run tree refuses is recorded and does not lose the reply", async () => {
  // alpha stays running, asks beta, and beta's reply names alpha, which waits on beta.
  build({ script: { alpha: null, beta: "back to @alpha" } });
  await addAgents("alpha", "beta");
  const threadId = await newThread();
  const { runs: woken } = await say(threadId, "@alpha start");
  const [alphaRun] = woken;
  if (!alphaRun) {
    throw new Error("alpha was not woken");
  }

  const asAlpha: Principal = {
    agentId: agentId("alpha"),
    kind: "run",
    runId: alphaRun.runId,
    workspaceId: WORKSPACE,
  };
  const posted = await say(threadId, "@beta your turn", asAlpha);

  expect(posted.post).toMatchObject({
    authorId: agentId("alpha"),
    authorKind: "agent",
    runId: alphaRun.runId,
  });
  expect(posted.runs).toHaveLength(1);
  expect((await transcript(threadId)).map((post) => post.text)).toEqual([
    "@alpha start",
    "@beta your turn",
    "back to @alpha",
  ]);
  expect(stops()).toEqual([
    {
      agentId: agentId("alpha"),
      payload: expect.objectContaining({ reason: "refused" }),
    },
  ]);
});

test("threads belong to a workspace, and read-only keys only read", async () => {
  build({ script: { alpha: "hi" } });
  await addAgents("alpha");
  const threadId = await newThread();

  await expect(inbox.readThread(outsider, { threadId })).rejects.toMatchObject({
    code: "not_found",
  });
  await expect(say(threadId, "hi", outsider)).rejects.toMatchObject({
    code: "not_found",
  });
  expect(await inbox.listThreads(outsider)).toEqual([]);

  const readOnly: Principal = {
    ...user,
    apiKey: { access: "read", id: "k1" },
    via: "api_key",
  };
  expect(await inbox.listThreads(readOnly)).toHaveLength(1);
  await expect(say(threadId, "@alpha hi", readOnly)).rejects.toBeInstanceOf(
    ForbiddenError
  );
  expect(allRuns()).toEqual([]);
});

test("the thread list shows the most recently posted-to thread first", async () => {
  build({ script: { alpha: "hi" } });
  await addAgents("alpha");
  const older = await newThread();
  nowMs += 1000;
  const newer = await newThread();
  expect((await inbox.listThreads(user)).map((thread) => thread.id)).toEqual([
    newer,
    older,
  ]);

  nowMs += 1000;
  await say(older, "bump");

  expect((await inbox.listThreads(user)).map((thread) => thread.id)).toEqual([
    older,
    newer,
  ]);
});
