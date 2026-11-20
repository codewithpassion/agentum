import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { machines } from "@repo/db/schema/machines";
import {
  agentMailboxes,
  mailMessages,
  mailThreads,
} from "@repo/db/schema/mail";
import { memoryChanges } from "@repo/db/schema/memory";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { teamMembers, teams } from "@repo/db/schema/teams";
import { triggers } from "@repo/db/schema/triggers";
import { workspaces } from "@repo/db/schema/workspaces";
import type { RailView } from "@repo/db/shared";
import { defaultAgentAvatar } from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { createEventsService } from "./events.ts";
import { createRosterService } from "./roster.ts";
import type { Principal } from "./workspaces.ts";

const WORKSPACE = "w1";
const OTHER_WORKSPACE = "w2";
const NOW = "2026-01-01T00:00:00.000Z";
const user: Principal = {
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId: WORKSPACE,
};
const system: Principal = { kind: "system" };

let db: ReturnType<typeof migrated>;
let railView: RailView;
let queries: number;
const clock = { now: () => new Date(NOW), sleep: () => Promise.resolve() };
let service: ReturnType<typeof createRosterService>;

const seedWorkspace = (conn: ReturnType<typeof migrated>, id: string) =>
  conn
    .insert(workspaces)
    .values({
      clerkOrgId: `org_${id}`,
      createdAt: NOW,
      id,
      name: id,
      timezone: "UTC",
    })
    .run();

const insertAgent = (
  row: { id: string; name: string } & Partial<typeof agents.$inferInsert>
) =>
  db
    .insert(agents)
    .values({
      createdAt: NOW,
      createdBy: "u1",
      emailLocal: null,
      handsTo: "[]",
      instructions: "",
      machineId: null,
      model: "m",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: row.id,
      soul: "",
      status: "active",
      workspaceId: WORKSPACE,
      ...row,
    })
    .run();

const insertTeam = (row: { id: string } & Partial<typeof teams.$inferInsert>) =>
  db
    .insert(teams)
    .values({
      createdAt: NOW,
      name: row.id,
      slug: row.id,
      workspaceId: WORKSPACE,
      ...row,
    })
    .run();

const addAgentMember = (
  teamId: string,
  agentId: string,
  isHome: boolean,
  workspaceId = WORKSPACE
) =>
  db
    .insert(teamMembers)
    .values({
      isHome,
      memberId: agentId,
      memberKind: "agent",
      teamId,
      workspaceId,
    })
    .run();

beforeEach(() => {
  const migratedDb = migrated();
  queries = 0;
  db = Object.assign(
    drizzle(migratedDb.client, {
      logger: {
        logQuery: () => {
          queries += 1;
        },
      },
    }),
    { client: migratedDb.client }
  );
  seedWorkspace(db, WORKSPACE);
  seedWorkspace(db, OTHER_WORKSPACE);
  railView = {
    counts: { everyone: 0, mine: 0 },
    doneToday: 0,
    needsYou: [],
    working: [],
  };
  service = createRosterService({
    clock,
    db,
    rail: { get: () => Promise.resolve(railView) },
  });
});

test("lists active agents only, ordered by name, each as an idle card", async () => {
  insertAgent({
    avatar: '{"color":"blue","glyph":"Z"}',
    id: "a-zeta",
    instructions: "  \n  Line one.  \nLine two",
    name: "Zeta",
    soul: "Ignored soul",
  });
  insertAgent({ id: "a-alpha", instructions: "x".repeat(200), name: "Alpha" });
  insertAgent({ id: "a-old", name: "Old", status: "archived" });
  insertAgent({ id: "a-draft", name: "Drafted", status: "draft" });

  expect(await service.list(user)).toEqual([
    {
      avatar: { color: "slate", glyph: "?" },
      costThisWeekCents: 0,
      id: "a-alpha",
      isLead: false,
      jobLine: "x".repeat(80),
      learnedCount: 0,
      name: "Alpha",
      needsYouCount: 0,
      ownerName: "",
      slug: "a-alpha",
      state: "idle",
      statusLine: "Idle",
      teamId: null,
      weeklyCapCents: null,
    },
    {
      avatar: { color: "blue", glyph: "Z" },
      costThisWeekCents: 0,
      id: "a-zeta",
      isLead: false,
      jobLine: "Line one.",
      learnedCount: 0,
      name: "Zeta",
      needsYouCount: 0,
      ownerName: "",
      slug: "a-zeta",
      state: "idle",
      statusLine: "Idle",
      teamId: null,
      weeklyCapCents: null,
    },
  ]);
});

test("an avatar column that is not JSON, or does not validate, falls back to the default avatar", async () => {
  insertAgent({ avatar: "not json", id: "a-bad-json", name: "Bree" });
  insertAgent({
    avatar: '{"color":"pink","glyph":"B"}',
    id: "a-bad-color",
    name: "Cass",
  });

  const cards = await service.list(user);
  expect(cards.map((card) => card.avatar)).toEqual([
    defaultAgentAvatar("Bree"),
    defaultAgentAvatar("Cass"),
  ]);
});

test("a valid avatar column comes back unchanged", async () => {
  insertAgent({
    avatar: '{"color":"teal","glyph":"★"}',
    id: "a-good",
    name: "Dana",
  });

  const [card] = await service.list(user);
  expect(card?.avatar).toEqual({ color: "teal", glyph: "★" });
});

test("another workspace's agents are not listed", async () => {
  insertAgent({ id: "a-mine", name: "Mine" });
  insertAgent({
    id: "a-theirs",
    name: "Theirs",
    workspaceId: OTHER_WORKSPACE,
  });

  expect((await service.list(user)).map((card) => card.id)).toEqual(["a-mine"]);
});

test("the system principal is refused", async () => {
  await expect(service.list(system)).rejects.toBeInstanceOf(ForbiddenError);
});

const X_RUN_ELLIPSIS = /^x+\.\.\.$/;

const seedRun = (
  id: string,
  values: Partial<typeof runs.$inferInsert> = {},
  sessionValues: Partial<typeof sessions.$inferInsert> = {}
) => {
  db.insert(sessions)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: "a1",
      createdAt: NOW,
      id: `s-${id}`,
      origin: "slack",
      workspaceId: WORKSPACE,
      ...sessionValues,
    })
    .run();
  db.insert(runs)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: "a1",
      createdAt: NOW,
      id,
      inputText: "Prepare the report",
      sessionId: `s-${id}`,
      status: "running",
      workspaceId: WORKSPACE,
      ...values,
    })
    .run();
};

test("a running run supplies its task title", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1");
  expect((await service.list(user))[0]).toMatchObject({
    state: "working",
    statusLine: "Prepare the report",
  });
});

test.each(["failed", "interrupted"] as const)(
  "a %s last run is stopped, ahead of a running run",
  async (status) => {
    insertAgent({ id: "a1", name: "Alpha" });
    seedRun("r1", { createdAt: "2025-12-31T23:00:00.000Z" });
    seedRun("r2", { status });
    expect((await service.list(user))[0]?.state).toBe("stopped");
  }
);

test("an older failure does not stop a newer successful run", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { createdAt: "2025-12-31T23:00:00.000Z", status: "failed" });
  seedRun("r2", { status: "done" });
  expect((await service.list(user))[0]?.state).toBe("idle");
});

test("a revoked (archived) machine stops an agent even with a running run", async () => {
  db.insert(machines)
    .values({
      capabilities: "{}",
      createdAt: NOW,
      credentialHash: "hash",
      enrolledBy: "u1",
      id: "m1",
      name: "Mac",
      singleUser: false,
      status: "revoked",
      workspaceId: WORKSPACE,
    })
    .run();
  insertAgent({ id: "a1", machineId: "m1", name: "Alpha" });
  seedRun("r1");
  expect((await service.list(user))[0]?.state).toBe("stopped");
});

test("Needs you beats stopped and working; problems remain stopped", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { status: "failed" });
  const card = {
    agentId: "a1",
    agentName: "Alpha",
    at: NOW,
    detail: "",
    expiresAt: null,
    id: "q1",
    kind: "question" as const,
    mail: null,
    passedOnBy: null,
    runId: "r1",
    status: "Waiting",
    threadId: null,
    title: "Which report?",
  };
  railView.needsYou = [
    {
      assigneeName: "Ann",
      assigneeUserId: "u1",
      cards: [card],
      dueAt: null,
      escalatedToMe: false,
      id: "q1",
      mine: true,
    },
  ];
  expect((await service.list(user))[0]).toMatchObject({
    needsYouCount: 1,
    ownerName: "Ann",
    state: "needs_you",
    statusLine: "Which report?",
  });
  const [item] = railView.needsYou;
  if (item) {
    item.cards = [{ ...card, kind: "problem" }];
  }
  expect((await service.list(user))[0]).toMatchObject({
    needsYouCount: 0,
    state: "stopped",
  });
});

test("idle uses the earliest enabled routine, each cron read in its own zone", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  db.update(workspaces)
    .set({ timezone: "Australia/Sydney" })
    .where(eq(workspaces.id, WORKSPACE))
    .run();
  for (const [id, cron, disabledAt, revokedAt] of [
    ["late", "0 15 * * *", null, null],
    ["next", "0 12 * * *", null, null],
    ["disabled", "1 11 * * *", NOW, null],
    ["revoked", "2 11 * * *", null, NOW],
  ] as const) {
    db.insert(triggers)
      .values({
        agentId: "a1",
        createdAt: NOW,
        createdBy: "u1",
        cron,
        disabledAt,
        id,
        kind: "routine",
        name: id,
        revokedAt,
        timezone: "UTC",
        workspaceId: WORKSPACE,
      })
      .run();
  }
  expect((await service.list(user))[0]?.statusLine).toBe(
    // 12:00 UTC is 11:00 pm in Sydney.
    "Idle. Next run 1 Jan, 11:00 pm"
  );
});

test("a routine with no zone of its own is read in the workspace timezone", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  db.update(workspaces)
    .set({ timezone: "Australia/Sydney" })
    .where(eq(workspaces.id, WORKSPACE))
    .run();
  db.insert(triggers)
    .values({
      agentId: "a1",
      createdAt: NOW,
      createdBy: "u1",
      cron: "0 12 * * *",
      id: "t1",
      kind: "routine",
      name: "t1",
      timezone: null,
      workspaceId: WORKSPACE,
    })
    .run();
  expect((await service.list(user))[0]?.statusLine).toBe(
    "Idle. Next run 1 Jan, 12:00 pm"
  );
});

test("a run started by mail is titled by its mail subject", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { inputText: "x".repeat(300) });
  const [card] = await service.list(user);
  const clipped = String(card?.statusLine);
  expect(clipped).toMatch(X_RUN_ELLIPSIS);
  expect(clipped.length).toBeLessThan(120);

  db.delete(runs).run();
  db.delete(sessions).run();
  seedRun("r2", { inputText: "New mail arrived" });
  db.insert(agentMailboxes)
    .values({
      address: "alpha@example.test",
      agentId: "a1",
      createdAt: NOW,
      id: "mb1",
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(mailThreads)
    .values({
      externalThreadId: "ext1",
      id: "th1",
      lastMessageAt: NOW,
      mailboxId: "mb1",
      subject: "Invoice 42",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(mailMessages)
    .values({
      ccAddresses: "[]",
      createdAt: NOW,
      direction: "in",
      externalMessageId: "m1",
      fromAddress: "bo@example.test",
      id: "msg1",
      runId: "r2",
      snippet: "",
      status: "received",
      subject: "Invoice 42",
      threadId: "th1",
      toAddresses: "[]",
      workspaceId: WORKSPACE,
    })
    .run();
  expect((await service.list(user))[0]?.statusLine).toBe("Invoice 42");
});

const FINISHED_RECENTLY = "2025-12-31T23:56:00.000Z";

test("a run done minutes ago shows its finish time and title, as idle", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { finishedAt: FINISHED_RECENTLY, status: "done" });
  expect((await service.list(user))[0]).toMatchObject({
    state: "idle",
    statusLine: "Done 11:56 pm: Prepare the report",
  });
});

test("a run done minutes ago names the next routine run after its finish time", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { finishedAt: FINISHED_RECENTLY, status: "done" });
  db.insert(triggers)
    .values({
      agentId: "a1",
      createdAt: NOW,
      createdBy: "u1",
      cron: "0 12 * * *",
      id: "t1",
      kind: "routine",
      name: "t1",
      timezone: null,
      workspaceId: WORKSPACE,
    })
    .run();
  expect((await service.list(user))[0]?.statusLine).toBe(
    "Done 11:56 pm: Prepare the report. Next run 1 Jan, 12:00 pm"
  );
});

test("a run done minutes ago shows its finish time in the workspace timezone", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  db.update(workspaces)
    .set({ timezone: "Australia/Sydney" })
    .where(eq(workspaces.id, WORKSPACE))
    .run();
  seedRun("r1", { finishedAt: FINISHED_RECENTLY, status: "done" });
  expect((await service.list(user))[0]?.statusLine).toBe(
    // 23:56 UTC on 31 Dec is 10:56 am on 1 Jan in Sydney.
    "Done 10:56 am: Prepare the report"
  );
});

test("a run done more than a day ago is idle again", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { finishedAt: "2025-12-30T23:00:00.000Z", status: "done" });
  expect((await service.list(user))[0]?.statusLine).toBe("Idle");
});

test("a run done more than a day ago keeps the next routine run in idle", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { finishedAt: "2025-12-30T23:00:00.000Z", status: "done" });
  db.insert(triggers)
    .values({
      agentId: "a1",
      createdAt: NOW,
      createdBy: "u1",
      cron: "0 12 * * *",
      id: "t1",
      kind: "routine",
      name: "t1",
      timezone: null,
      workspaceId: WORKSPACE,
    })
    .run();
  expect((await service.list(user))[0]?.statusLine).toBe(
    "Idle. Next run 1 Jan, 12:00 pm"
  );
});

test("a run done minutes ago started by mail is titled by its mail subject", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", {
    finishedAt: FINISHED_RECENTLY,
    inputText: "x".repeat(300),
    status: "done",
  });
  db.insert(agentMailboxes)
    .values({
      address: "alpha@example.test",
      agentId: "a1",
      createdAt: NOW,
      id: "mb1",
      status: "active",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(mailThreads)
    .values({
      externalThreadId: "ext1",
      id: "th1",
      lastMessageAt: NOW,
      mailboxId: "mb1",
      subject: "Invoice 42",
      workspaceId: WORKSPACE,
    })
    .run();
  db.insert(mailMessages)
    .values({
      ccAddresses: "[]",
      createdAt: NOW,
      direction: "in",
      externalMessageId: "m1",
      fromAddress: "bo@example.test",
      id: "msg1",
      runId: "r1",
      snippet: "",
      status: "received",
      subject: "Invoice 42",
      threadId: "th1",
      toAddresses: "[]",
      workspaceId: WORKSPACE,
    })
    .run();
  expect((await service.list(user))[0]?.statusLine).toBe(
    "Done 11:56 pm: Invoice 42"
  );
});

test("a failed run finished minutes ago is still stopped", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { finishedAt: FINISHED_RECENTLY, status: "failed" });
  expect((await service.list(user))[0]).toMatchObject({
    state: "stopped",
    statusLine: "Failed",
  });
});

test("a waiting run finished minutes ago still shows as needing you", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", { finishedAt: FINISHED_RECENTLY, status: "done" });
  railView.needsYou = [
    {
      assigneeName: "Ann",
      assigneeUserId: "u1",
      cards: [
        {
          agentId: "a1",
          agentName: "Alpha",
          at: NOW,
          detail: "",
          expiresAt: null,
          id: "q1",
          kind: "question",
          mail: null,
          passedOnBy: null,
          runId: "r1",
          status: "Waiting",
          threadId: null,
          title: "Which report?",
        },
      ],
      dueAt: null,
      escalatedToMe: false,
      id: "q1",
      mine: true,
    },
  ];
  expect((await service.list(user))[0]).toMatchObject({
    state: "needs_you",
    statusLine: "Which report?",
  });
});

test("a running run newer than a done run is still working", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("r1", {
    createdAt: "2025-12-31T23:00:00.000Z",
    finishedAt: "2025-12-31T23:30:00.000Z",
    status: "done",
  });
  seedRun("r2");
  expect((await service.list(user))[0]).toMatchObject({
    state: "working",
    statusLine: "Prepare the report",
  });
});

test("a bounced-mail problem is a Needs you item", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  railView.needsYou = [
    {
      assigneeName: "Ann",
      assigneeUserId: "u1",
      cards: [
        {
          agentId: "a1",
          agentName: "Alpha",
          at: NOW,
          detail: "Mail to bo@example.test bounced",
          expiresAt: null,
          id: "p1",
          kind: "problem",
          mail: null,
          passedOnBy: null,
          runId: "r1",
          status: "Mail bounced",
          threadId: null,
          title: "Reply to Bo",
        },
      ],
      dueAt: null,
      escalatedToMe: false,
      id: "p1",
      mine: true,
    },
  ];
  expect((await service.list(user))[0]).toMatchObject({
    needsYouCount: 1,
    state: "needs_you",
    statusLine: "Reply to Bo",
  });
});

test("cost sums the last seven days, rounds once to cents, excludes dry and hidden runs", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  seedRun("one", { usage: '{"costUsd":0.124}' });
  seedRun("two", {
    createdAt: "2025-12-25T00:00:00.000Z",
    status: "done",
    usage: '{"costUsd":0.124}',
  });
  seedRun("old", {
    createdAt: "2025-12-24T23:59:59.999Z",
    usage: '{"costUsd":100}',
  });
  seedRun("dry", { dryRun: true, usage: '{"costUsd":100}' });
  seedRun(
    "hidden",
    { usage: '{"costUsd":100}' },
    { actorId: "u2", private: true }
  );
  seedRun("missing", { usage: "{}" });
  expect((await service.list(user))[0]?.costThisWeekCents).toBe(25);
});

test("a member sees exactly the same agents as agents.list", async () => {
  insertAgent({ id: "mine", name: "Mine" });
  insertAgent({ id: "other-owner", name: "Other", ownerUserId: "u2" });
  insertAgent({ id: "archived", name: "Archived", status: "archived" });
  insertAgent({ id: "draft", name: "Draft", status: "draft" });
  insertAgent({ id: "foreign", name: "Foreign", workspaceId: OTHER_WORKSPACE });
  const events = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  const agentService = createAgentsService({
    atomic: sqliteAtomic(db),
    db,
    events,
  });
  expect((await service.list(user)).map((card) => card.id)).toEqual(
    (await agentService.list(user)).map((agent) => agent.id)
  );
});

test("50 agents use a constant number of database queries", async () => {
  for (let index = 0; index < 50; index += 1) {
    insertAgent({ id: `a${index}`, name: `Agent ${index}` });
    seedRun(`r${index}`, { agentId: `a${index}` }, { agentId: `a${index}` });
  }
  queries = 0;
  expect(await service.list(user)).toHaveLength(50);
  expect(queries).toBeLessThanOrEqual(8);
});

test("job line keeps the first sentence and clips Unicode instructions to 80 characters", async () => {
  insertAgent({
    id: "a1",
    instructions: "  Keep\naccounts tidy! Send a report.",
    name: "Alpha",
    soul: "Ignore me.",
  });
  insertAgent({
    id: "a2",
    instructions: `${"★".repeat(79)}😀😀`,
    name: "Beta",
  });
  expect((await service.list(user)).map((card) => card.jobLine)).toEqual([
    "Keep accounts tidy!",
    `${"★".repeat(79)}😀`,
  ]);
});

test("owner names are resolved for idle agents with creator fallback", async () => {
  insertAgent({ id: "a1", name: "Alpha", ownerUserId: "u2" });
  insertAgent({ id: "a2", name: "Beta" });
  const named = createRosterService({
    clock,
    db,
    members: {
      list: () =>
        Promise.resolve([
          { name: "Ann", userId: "u1" },
          { name: "Bob", userId: "u2" },
        ]),
    },
    rail: { get: () => Promise.resolve(railView) },
  });
  expect((await named.list(user)).map((card) => card.ownerName)).toEqual([
    "Bob",
    "Ann",
  ]);
});

test("authorization fails before executing a database query", async () => {
  queries = 0;
  await expect(service.list(system)).rejects.toBeInstanceOf(ForbiddenError);
  expect(queries).toBe(0);
});

test("an agent with no team rows has no team and is not a lead", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  expect(await service.list(user)).toMatchObject([
    { id: "a1", isLead: false, teamId: null },
  ]);
});

test("an agent that is a home member of a team reports that team, not as lead", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  insertTeam({ id: "t1" });
  addAgentMember("t1", "a1", true);
  expect(await service.list(user)).toMatchObject([
    { id: "a1", isLead: false, teamId: "t1" },
  ]);
});

test("the lead of its home team is a lead", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  insertTeam({ id: "t1", leadAgentId: "a1" });
  addAgentMember("t1", "a1", true);
  expect(await service.list(user)).toMatchObject([
    { id: "a1", isLead: true, teamId: "t1" },
  ]);
});

test("a non-home membership does not replace the home team", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  insertTeam({ id: "t-second" });
  insertTeam({ id: "t-home" });
  addAgentMember("t-second", "a1", false);
  addAgentMember("t-home", "a1", true);
  expect(await service.list(user)).toMatchObject([
    { id: "a1", teamId: "t-home" },
  ]);
});

test("an agent whose home team is archived has no team and is not a lead", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  insertTeam({ archivedAt: NOW, id: "t1", leadAgentId: "a1" });
  addAgentMember("t1", "a1", true);
  expect(await service.list(user)).toMatchObject([
    { id: "a1", isLead: false, teamId: null },
  ]);
});

test("a home team in another workspace does not leak into this roster", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  insertTeam({
    id: "t-other",
    leadAgentId: "a1",
    workspaceId: OTHER_WORKSPACE,
  });
  addAgentMember("t-other", "a1", true, OTHER_WORKSPACE);
  expect(await service.list(user)).toMatchObject([
    { id: "a1", isLead: false, teamId: null },
  ]);
});

test("learnedCount counts applied changes per agent in the rolling seven days, respecting workspace and private scope", async () => {
  insertAgent({ id: "a1", name: "Alpha" });
  insertAgent({ id: "a2", name: "Beta" });
  insertAgent({ id: "a3", name: "Gamma" });
  insertAgent({ id: "foreign", name: "Foreign", workspaceId: OTHER_WORKSPACE });
  const changes: ({ id: string } & Partial<
    typeof memoryChanges.$inferInsert
  >)[] = [
    { id: "recent" },
    { createdAt: "2025-12-25T00:00:00.000Z", id: "boundary" },
    { createdAt: "2025-12-24T23:59:59.999Z", id: "old" },
    { id: "held", status: "held" },
    { id: "rejected", status: "rejected" },
    { id: "undone", status: "undone" },
    { agentId: "foreign", id: "foreign", workspaceId: OTHER_WORKSPACE },
    { id: "private", userScope: "u2" },
    { id: "own-private", userScope: "u1" },
    { action: "edit", agentId: "a2", decidedAt: NOW, id: "beta" },
    // Approval does not change the history's creation time.
    {
      createdAt: "2025-12-24T00:00:00.000Z",
      decidedAt: NOW,
      id: "old-approved",
    },
  ];
  await db.insert(memoryChanges).values(
    changes.map((change) => ({
      action: "add" as const,
      agentId: "a1",
      createdAt: NOW,
      kind: "work" as const,
      noteId: change.id,
      status: "applied" as const,
      text: "A learned note",
      workspaceId: WORKSPACE,
      writtenBy: "agent" as const,
      ...change,
    }))
  );

  expect(
    (await service.list(user)).map((card) => [card.id, card.learnedCount])
  ).toEqual([
    ["a1", 3],
    ["a2", 1],
    ["a3", 0],
  ]);
  expect(
    (await service.list({ ...user, userId: "u2" })).map(
      (card) => card.learnedCount
    )
  ).toEqual([3, 1, 0]);
});
