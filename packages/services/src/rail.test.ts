import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import {
  agentMailboxes,
  mailMessages,
  mailThreads,
} from "@repo/db/schema/mail";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { workspaces } from "@repo/db/schema/workspaces";
import {
  APPROVAL_TTL_MS,
  MAIL_APPROVAL_TTL_MS,
  MAIL_SEND_TOOL,
  RAIL_ESCALATE_AFTER_MS,
  type RailScope,
  type RunStatus,
  type WorkspaceMember,
} from "@repo/db/shared";
import { migrated } from "@repo/db/test-db";
import { createMasker } from "@repo/protocol/masker";
import { eq } from "drizzle-orm";
import { type AgentsService, createAgentsService } from "./agents.ts";
import { ForbiddenError } from "./authz.ts";
import { createDeskService } from "./desk.ts";
import { createEventsService, type PeopleLookup } from "./events.ts";
import { createInboxService } from "./inbox.ts";
import { memoryLibraryBlobs } from "./library/memory.ts";
import { createLibraryService } from "./library.ts";
import { createMembersService } from "./members.ts";
import { createRailService } from "./rail.ts";
import { createRequestsService } from "./requests.ts";
import { createRoutinesService } from "./routines.ts";
import type { RuntimeAdapter } from "./runs/types.ts";
import { createRunsService } from "./runs.ts";
import { memorySkillBlobs } from "./skills-store/memory.ts";
import { createSkillsStoreService } from "./skills-store.ts";
import { createTriggersService } from "./triggers.ts";
import { type Principal, SYSTEM_PRINCIPAL as system } from "./workspaces.ts";

const user = (userId = "u1", workspaceId = "w1"): Principal => ({
  kind: "user",
  userId,
  via: "session",
  workspaceId,
});
const DAY_START = "2026-10-26T00:00:00.000Z";
const NOW = Date.parse("2026-10-26T09:00:00Z");
const HOUR = 60 * 60_000;

const ANN: WorkspaceMember = { name: "Ann", userId: "u1" };
const BOB: WorkspaceMember = { name: "Bob", userId: "u2" };
const CY: WorkspaceMember = { name: "Cy", userId: "u3" };

let db: ReturnType<typeof migrated>;
let now: number;
let counter: number;
let memberList: WorkspaceMember[] | null;
let hasKey: boolean;
let hasAnthropic: boolean;
let people: PeopleLookup | undefined;
let agents: AgentsService;
let requests: ReturnType<typeof createRequestsService>;
let runs: ReturnType<typeof createRunsService>;
let desk: ReturnType<typeof createDeskService>;
let rail: ReturnType<typeof createRailService>;
let a1: string;
let a2: string;

const view = (scope: RailScope = "mine", principal: Principal = user()) =>
  rail.get(principal, { dayStart: DAY_START, scope });

const titles = (items: { cards: { title: string }[] }[]) =>
  items.map((item) => item.cards.map((card) => card.title));

let errors: ReturnType<typeof spyOn>;

afterEach(() => {
  errors.mockRestore();
});

beforeEach(async () => {
  // The member lookup failure tests log on purpose.
  errors = spyOn(console, "error").mockImplementation(() => undefined);
  db = migrated();
  now = NOW;
  counter = 0;
  memberList = [ANN, BOB, CY];
  hasKey = true;
  hasAnthropic = false;
  people = undefined;
  const iso = new Date(now).toISOString();
  await db.insert(workspaces).values(
    ["w1", "w3"].map((id) => ({
      clerkOrgId: `org_${id}`,
      createdAt: iso,
      id,
      name: id,
      timezone: "UTC",
    }))
  );
  const clock = {
    now: () => new Date(now),
    sleep: () => Promise.resolve(),
  };
  const blobs = {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
  };
  const atomic = sqliteAtomic(db);
  const events = createEventsService({ blobs, db });
  const adapter: RuntimeAdapter = {
    cancel: () => Promise.resolve(),
    dispatch: () => Promise.resolve(),
    kind: "cloud",
    resume: () => Promise.resolve(),
  };
  runs = createRunsService({
    adapters: [adapter],
    atomic,
    blobs,
    clock,
    db,
    devFakeRuntime: false,
    gateways: [],
  });
  requests = createRequestsService({
    atomic,
    clock,
    db,
    events,
    runs,
    secrets: {
      maskerFor: () =>
        Promise.resolve(createMasker({ NAME: "granted-value-123" })),
    },
  });
  const library = createLibraryService({
    atomic,
    blobs: memoryLibraryBlobs(),
    clock,
    db,
    events,
  });
  const skillsStore = createSkillsStoreService({
    atomic,
    blobs: memorySkillBlobs(),
    clock,
    db,
    events,
    library,
  });
  const triggers = createTriggersService({
    allowedOrgIds: ["org_w1", "org_w3"],
    clock,
    db,
    events,
    runs,
  });
  const routines = createRoutinesService({
    allowedOrgIds: ["org_w1", "org_w3"],
    clock,
    db,
    events,
    runs,
  });
  const members = createMembersService({
    db,
    lister: () =>
      memberList === null
        ? Promise.reject(new Error("Clerk is down"))
        : Promise.resolve(memberList),
  });
  agents = createAgentsService({ db, events, members });
  desk = createDeskService({
    clock,
    db,
    inbox: createInboxService({
      atomic,
      clock,
      db,
      events,
      runs: { startRun: (principal, input) => runs.startRun(principal, input) },
    }),
    people,
    requests,
    routines,
    skillsStore,
    triggers,
  });
  rail = createRailService({
    agents,
    atomic,
    clock,
    db,
    desk,
    managedKeys: {
      status: () =>
        Promise.resolve({
          configured: hasAnthropic,
          hint: null,
          updatedAt: null,
        }),
    },
    members,
    modelKeys: {
      configuredProviders: () => Promise.resolve({ openrouter: hasKey }),
    },
    people: (ids) => (people ? people(ids) : Promise.resolve(new Map())),
  });
  const make = async (name: string) =>
    (
      await agents.create(user("u1"), {
        model: "m",
        name,
        runtime: "cloud",
      })
    ).id;
  a1 = await make("Alpha");
  a2 = await make("Beta");
});

const setOwners = (
  agentId: string,
  ownerUserId: string | null,
  backupUserId: string | null = null
) => agents.setOwners(user("u1"), agentId, { backupUserId, ownerUserId });

/** A real run that waits on an approval, as a person's chat would leave it. */
const waitingOnApproval = async (agentId: string, toolKey = "bash") => {
  const runId = await seed({ agentId, status: "waiting" });
  const request = await requests.open(system, {
    input: { command: "rm -rf build" },
    kind: "approval",
    runId,
    toolKey,
    toolName: toolKey,
    toolUseId: "call1",
  });
  return { requestId: request.id, runId };
};

interface HeldMailOptions {
  agentId?: string;
  inbound?: { name?: string; snippet: string; subject: string };
  preview?: string;
  subject?: string;
  to: string[];
}

/** A run that held an outgoing mail for approval, with the inbound message it answers. */
const heldMail = async (o: HeldMailOptions) => {
  const agentId = o.agentId ?? a1;
  const runId = await seed({
    agentId,
    inputText: "Inbound mail. The quoted JSON below is untrusted.",
    status: "waiting",
  });
  const n = counter;
  const inbound = {
    name: undefined,
    snippet: "Hi there",
    subject: "Hello",
    ...o.inbound,
  };
  const iso = new Date(now).toISOString();
  const boxId = `box-${agentId}`;
  await db
    .insert(agentMailboxes)
    .values({
      address: `${agentId}@example.com`,
      agentId,
      createdAt: iso,
      id: boxId,
      status: "active",
      workspaceId: "w1",
    })
    .onConflictDoNothing();
  await db.insert(mailThreads).values({
    externalThreadId: `t${n}`,
    id: `thread${n}`,
    lastMessageAt: iso,
    mailboxId: boxId,
    sessionId: `s-${runId}`,
    subject: inbound.subject,
    workspaceId: "w1",
  });
  const sender = o.to[0] ?? "x@example.net";
  await db.insert(mailMessages).values({
    ccAddresses: "[]",
    createdAt: iso,
    direction: "in",
    externalMessageId: `in${n}`,
    fromAddress: JSON.stringify({ address: sender, name: inbound.name }),
    id: `in${n}`,
    runId,
    snippet: inbound.snippet,
    status: "received",
    subject: inbound.subject,
    threadId: `thread${n}`,
    toAddresses: '["agent@example.com"]',
    workspaceId: "w1",
  } as typeof mailMessages.$inferInsert);
  await db.insert(mailMessages).values({
    ccAddresses: "[]",
    createdAt: iso,
    direction: "out",
    externalMessageId: `out${n}`,
    fromAddress: '{"address":"agent@example.com"}',
    id: `out${n}`,
    runId,
    snippet: "short",
    status: "held",
    subject: o.subject ?? "Re: Quarterly numbers",
    threadId: `thread${n}`,
    toAddresses: JSON.stringify(o.to),
    workspaceId: "w1",
  });
  const request = await requests.open(
    system,
    {
      input: {
        cc: [],
        from: "agent@example.com",
        preview: o.preview ?? "Here are the numbers you asked for.",
        subject: o.subject ?? "Re: Quarterly numbers",
        to: o.to,
      },
      kind: "approval",
      runId,
      toolKey: `mail:${sender}`,
      toolName: MAIL_SEND_TOOL,
      toolUseId: `mail:out${n}`,
    },
    { ttlMs: MAIL_APPROVAL_TTL_MS }
  );
  return { requestId: request.id, runId };
};

interface SeedRun {
  actorId?: string;
  actorKind?: string;
  agentId?: string;
  finishedAt?: string;
  inputText?: string;
  parentRunId?: string;
  private?: boolean;
  status: RunStatus;
  userId?: string;
}

/** A run row with its session, inserted directly so its times are exact. */
const seed = async (o: SeedRun): Promise<string> => {
  counter += 1;
  const id = `run${String(counter).padStart(3, "0")}`;
  const createdAt = new Date(NOW - 60_000 + counter * 1000).toISOString();
  await db.insert(sessions).values({
    actorId: o.userId ?? "u1",
    actorKind: "user",
    agentId: o.agentId ?? a1,
    createdAt,
    id: `s-${id}`,
    origin: "mcp",
    private: o.private ?? false,
    workspaceId: "w1",
  });
  await db.insert(runRows).values({
    actorId: o.actorId ?? o.userId ?? "u1",
    actorKind: o.actorKind ?? "user",
    agentId: o.agentId ?? a1,
    createdAt,
    finishedAt: o.finishedAt ?? null,
    id,
    inputText: o.inputText ?? `Task ${id}`,
    parentRunId: o.parentRunId ?? null,
    sessionId: `s-${id}`,
    startedAt: o.status === "running" ? createdAt : null,
    status: o.status,
    workspaceId: "w1",
  });
  return id;
};

test("Mine holds the items of the agents I own and Everyone holds all, naming who each is for", async () => {
  await setOwners(a2, "u2");
  await waitingOnApproval(a1);
  await waitingOnApproval(a2);

  const ann = await view("mine", user("u1"));
  const bob = await view("mine", user("u2"));
  const everyone = await view("everyone", user("u1"));

  // Alpha has no owner, so it asks its creator, Ann.
  expect(ann.needsYou.map((item) => item.cards[0]?.agentName)).toEqual([
    "Alpha",
  ]);
  expect(bob.needsYou.map((item) => item.cards[0]?.agentName)).toEqual([
    "Beta",
  ]);
  expect(ann.counts).toEqual({ everyone: 2, mine: 1 });
  expect(
    everyone.needsYou.map((item) => [
      item.cards[0]?.agentName,
      item.assigneeName,
    ])
  ).toEqual(
    expect.arrayContaining([
      ["Alpha", "Ann"],
      ["Beta", "Bob"],
    ])
  );
});

test("an agent whose creator left the organisation has nobody to ask, so the item is in everyone's Mine", async () => {
  memberList = [BOB, CY];
  await waitingOnApproval(a1);

  const views = await Promise.all(
    ["u2", "u3"].map((userId) => view("mine", user(userId)))
  );
  for (const mine of views) {
    expect(mine.needsYou).toHaveLength(1);
    expect(mine.needsYou[0]?.assigneeName).toBeNull();
    expect(mine.needsYou[0]?.assigneeUserId).toBeNull();
  }
});

test("an owner who left the organisation counts as nobody", async () => {
  await setOwners(a2, "u2");
  await waitingOnApproval(a2);
  memberList = [ANN, CY];

  expect((await view("mine", user("u3"))).needsYou).toHaveLength(1);
  expect((await view("mine", user("u1"))).needsYou).toHaveLength(1);
});

test("when the member lookup fails, Mine shows everything", async () => {
  await setOwners(a2, "u2");
  await waitingOnApproval(a1);
  await waitingOnApproval(a2);
  memberList = null;

  const result = await view("mine", user("u3"));

  expect(result.needsYou).toHaveLength(2);
  expect(result.counts).toEqual({ everyone: 2, mine: 2 });
});

test("an item older than 4 hours also shows in the backup's Mine, marked as asked too", async () => {
  await setOwners(a1, "u1", "u2");
  await heldMail({ to: ["priya@acme.com"] });

  now = NOW + RAIL_ESCALATE_AFTER_MS - 1;
  expect((await view("mine", user("u2"))).needsYou).toHaveLength(0);

  now = NOW + RAIL_ESCALATE_AFTER_MS;
  const backup = await view("mine", user("u2"));
  const owner = await view("mine", user("u1"));

  expect(backup.needsYou).toHaveLength(1);
  expect(backup.needsYou[0]?.escalatedToMe).toBe(true);
  expect(owner.needsYou[0]?.escalatedToMe).toBe(false);
  expect((await view("mine", user("u3"))).needsYou).toHaveLength(0);
});

test("a backup who left the organisation is not asked", async () => {
  await setOwners(a1, "u1", "u2");
  await heldMail({ to: ["priya@acme.com"] });
  memberList = [ANN, CY];
  now = NOW + 5 * HOUR;

  expect((await view("mine", user("u3"))).needsYou).toHaveLength(0);
});

test("any member can still answer a request assigned to someone else", async () => {
  await setOwners(a2, "u2");
  const { requestId } = await waitingOnApproval(a2);

  expect((await view("mine", user("u3"))).needsYou).toHaveLength(0);
  const answered = await requests.answer(user("u3"), {
    answer: { decision: "allow_once" },
    requestId,
    via: "web",
  });

  expect(answered.status).toBe("answered");
  expect((await view("everyone", user("u2"))).needsYou).toHaveLength(0);
});

test("a mail approval reads as a reply, with the body, what they wrote and a due time", async () => {
  await heldMail({
    inbound: {
      name: "Priya Nair",
      snippet: "Please send the numbers by 9am tomorrow",
      subject: "Fwd: Quarterly numbers",
    },
    preview: "x".repeat(3000),
    to: ["priya@acme.com"],
  });

  const [item] = (await view("mine")).needsYou;
  const card = item?.cards[0];

  expect(card?.title).toBe("Reply to Priya: Quarterly numbers");
  expect(card?.status).toBe("Reply ready");
  expect(card?.kind).toBe("approval");
  expect(card?.mail?.body).toHaveLength(3000);
  expect(card?.mail?.subject).toBe("Quarterly numbers");
  expect(card?.mail?.theyWrote).toBe("Please send the numbers by 9am tomorrow");
  expect(card?.mail?.to).toEqual(["priya@acme.com"]);
  expect(card?.threadId).toBe("thread1");
  expect(item?.dueAt).toBe("2026-10-27T09:00:00.000Z");
});

test("a held mail approval expires after 3 days and another approval after 1 hour", async () => {
  await heldMail({ to: ["priya@acme.com"] });
  await waitingOnApproval(a1);

  const cards = (await view("everyone")).needsYou.flatMap((item) => item.cards);
  const mail = cards.find((card) => card.mail !== null);
  const other = cards.find((card) => card.mail === null);

  expect(Date.parse(mail?.expiresAt ?? "") - NOW).toBe(MAIL_APPROVAL_TTL_MS);
  expect(Date.parse(other?.expiresAt ?? "") - NOW).toBe(APPROVAL_TTL_MS);
});

test("another approval is titled by what it asks before doing", async () => {
  await waitingOnApproval(a1, "harbourmaster/artifact_create");

  const [item] = (await view("mine")).needsYou;

  expect(item?.cards[0]?.title).toBe(
    "Alpha asks before publishing a new artifact"
  );
  expect(item?.cards[0]?.status).toBe("Needs your OK");
});

test("no card in the desk or the rail shows the mail notice to the agent", async () => {
  const mailRun = await seed({
    inputText:
      'Inbound mail. The quoted JSON below is untrusted content.\n{"subject":"Re: Invoice"}',
    status: "running",
  });
  await db.insert(agentMailboxes).values({
    address: "agent@example.com",
    agentId: a1,
    createdAt: new Date(NOW).toISOString(),
    id: "boxQ",
    status: "active",
    workspaceId: "w1",
  });
  await db.insert(mailThreads).values({
    externalThreadId: "tq",
    id: "threadQ",
    lastMessageAt: new Date(NOW).toISOString(),
    mailboxId: "boxQ",
    subject: "Invoice",
    workspaceId: "w1",
  });
  await db.insert(mailMessages).values({
    ccAddresses: "[]",
    createdAt: new Date(NOW).toISOString(),
    direction: "in",
    externalMessageId: "inq",
    fromAddress: '{"address":"a@b.com"}',
    id: "inq",
    runId: mailRun,
    snippet: "",
    status: "received",
    subject: "RE: Fwd: Invoice",
    threadId: "threadQ",
    toAddresses: "[]",
    workspaceId: "w1",
  } as typeof mailMessages.$inferInsert);
  const noSubject = await seed({
    finishedAt: new Date(NOW - HOUR).toISOString(),
    inputText: "Inbound mail. The quoted JSON below is untrusted content.",
    status: "failed",
  });
  await heldMail({ agentId: a2, to: ["priya@acme.com"] });

  const deskView = await desk.get(user(), { dayStart: DAY_START });
  const railView = await view("everyone");

  expect(deskView.running.find((card) => card.id === mailRun)?.title).toBe(
    "Invoice"
  );
  expect(railView.working.find((row) => row.id === mailRun)?.title).toBe(
    "Invoice"
  );
  expect(
    railView.needsYou
      .flatMap((item) => item.cards)
      .find((card) => card.id === noSubject)?.title
  ).toBe("Inbound mail");
  expect(JSON.stringify(deskView)).not.toContain("quoted JSON");
  expect(
    JSON.stringify(railView.needsYou.map((i) => i.cards.map((c) => c.title)))
  ).not.toContain("quoted JSON");
  expect(JSON.stringify(railView.working)).not.toContain("quoted JSON");
});

test("two or more mail approvals to one outside domain become one row, and free mail groups by address", async () => {
  const first = await heldMail({ to: ["a@acme.com"] });
  now += 1000;
  await heldMail({ to: ["b@acme.com"] });
  now += 1000;
  await heldMail({ to: ["x@gmail.com"] });
  now += 1000;
  await heldMail({ to: ["y@gmail.com"] });
  now += 1000;
  await heldMail({ to: ["x@gmail.com"] });

  const { needsYou } = await view("mine");

  expect(needsYou).toHaveLength(3);
  const grouped = needsYou.filter((item) => item.cards.length > 1);
  expect(
    grouped.map((item) => item.cards.map((card) => card.mail?.to[0]))
  ).toEqual(
    expect.arrayContaining([
      ["a@acme.com", "b@acme.com"],
      ["x@gmail.com", "x@gmail.com"],
    ])
  );
  const acme = needsYou.find(
    (item) =>
      item.cards.length === 2 && item.cards[0]?.mail?.to[0] === "a@acme.com"
  );
  expect(acme?.id).toBe(first.requestId);
});

test("approvals to one domain for different people stay in separate rows", async () => {
  await setOwners(a2, "u2");
  await heldMail({ agentId: a1, to: ["a@acme.com"] });
  await heldMail({ agentId: a2, to: ["b@acme.com"] });

  const { needsYou } = await view("everyone");

  expect(needsYou).toHaveLength(2);
});

test("Needs you sorts by due time, then undated items oldest first", async () => {
  const undatedOld = await waitingOnApproval(a1);
  now += 1000;
  await heldMail({
    inbound: { snippet: "This is urgent", subject: "Contract" },
    subject: "Contract",
    to: ["legal@firm.com"],
  });
  now += 1000;
  await heldMail({
    inbound: { snippet: "Need it by 9am tomorrow", subject: "Deck" },
    subject: "Deck",
    to: ["boss@corp.com"],
  });
  now += 1000;
  const undatedNew = await waitingOnApproval(a1, "write");

  const { needsYou } = await view("mine");

  expect(titles(needsYou).map(([title]) => title)).toEqual([
    "Reply to legal@firm.com: Contract",
    "Reply to boss@corp.com: Deck",
    "Alpha asks before bash",
    "Alpha asks before write",
  ]);
  expect(needsYou[2]?.id).toBe(undatedOld.requestId);
  expect(needsYou[3]?.id).toBe(undatedNew.requestId);
  expect(needsYou[0]?.dueAt).toBe("2026-10-26T23:59:59.999Z");
});

test("a failed run, an interrupted run and bounced mail need a person until dismissed", async () => {
  const failed = await seed({
    finishedAt: new Date(NOW - 2 * 24 * HOUR).toISOString(),
    status: "failed",
  });
  const interrupted = await seed({
    finishedAt: new Date(NOW - HOUR).toISOString(),
    status: "interrupted",
  });
  const tooOld = await seed({
    finishedAt: new Date(NOW - 8 * 24 * HOUR).toISOString(),
    status: "failed",
  });
  const finishedFine = await seed({
    finishedAt: new Date(NOW - HOUR).toISOString(),
    status: "done",
  });
  const bounced = await seed({
    finishedAt: new Date(NOW - HOUR).toISOString(),
    status: "done",
  });
  await db.insert(agentMailboxes).values({
    address: "agent@example.com",
    agentId: a1,
    createdAt: new Date(NOW).toISOString(),
    id: "boxB",
    status: "active",
    workspaceId: "w1",
  });
  await db.insert(mailThreads).values({
    externalThreadId: "tb",
    id: "threadB",
    lastMessageAt: new Date(NOW).toISOString(),
    mailboxId: "boxB",
    subject: "Help",
    workspaceId: "w1",
  });
  await db.insert(mailMessages).values({
    ccAddresses: "[]",
    createdAt: new Date(NOW - HOUR).toISOString(),
    direction: "out",
    externalMessageId: "outb",
    fromAddress: '{"address":"agent@example.com"}',
    id: "outb",
    runId: bounced,
    snippet: "",
    status: "bounced",
    subject: "Help",
    threadId: "threadB",
    toAddresses: '["gone@example.net"]',
    workspaceId: "w1",
  });

  const { needsYou } = await view("mine");
  const byRun = new Map(
    needsYou.map((item) => [item.id, item.cards[0]] as const)
  );

  expect([...byRun.keys()].sort()).toEqual(
    [bounced, failed, interrupted].sort()
  );
  expect(byRun.get(failed)).toMatchObject({
    kind: "problem",
    status: "Failed",
  });
  expect(byRun.get(interrupted)?.status).toBe("Stopped part way");
  expect(byRun.get(bounced)?.status).toBe("Mail bounced");
  expect(byRun.has(tooOld)).toBe(false);
  expect(byRun.has(finishedFine)).toBe(false);

  await rail.clearAttention(user("u3"), failed);

  const after = (await view("mine")).needsYou.map((item) => item.id);
  expect(after).not.toContain(failed);
  expect(after).toContain(interrupted);
  const [row] = await db.select().from(runRows).where(eq(runRows.id, failed));
  expect(row?.attentionClearedBy).toBe("u3");
  expect(row?.attentionClearedAt).toBe(new Date(NOW).toISOString());

  now += HOUR;
  await rail.clearAttention(user("u2"), failed);
  const [again] = await db.select().from(runRows).where(eq(runRows.id, failed));
  expect(again?.attentionClearedBy).toBe("u3");
});

test("a run in another member's private session can't be dismissed and never shows", async () => {
  const hidden = await seed({
    finishedAt: new Date(NOW - HOUR).toISOString(),
    private: true,
    status: "failed",
    userId: "u2",
  });

  expect((await view("everyone", user("u1"))).needsYou).toHaveLength(0);
  await expect(rail.clearAttention(user("u1"), hidden)).rejects.toMatchObject({
    code: "not_found",
  });
  expect((await view("everyone", user("u2"))).needsYou).toHaveLength(1);
});

test("a hand-off says who passed it on, by parent run or by agent actor", async () => {
  const parent = await seed({
    agentId: a1,
    finishedAt: new Date(NOW).toISOString(),
    status: "done",
  });
  const viaParent = await seed({
    agentId: a2,
    parentRunId: parent,
    status: "running",
  });
  const viaActor = await seed({
    actorId: a1,
    actorKind: "agent",
    agentId: a2,
    status: "running",
  });
  const plain = await seed({ agentId: a2, status: "running" });

  const { working } = await view("everyone");
  const passed = new Map(working.map((row) => [row.id, row.passedOnBy]));

  expect(passed.get(viaParent)).toBe("Alpha");
  expect(passed.get(viaActor)).toBe("Alpha");
  expect(passed.get(plain)).toBeNull();
});

test("Working and Done today follow the scope, and a run waiting on a person is not in Working", async () => {
  await setOwners(a2, "u2");
  const mineRun = await seed({ agentId: a1, status: "running" });
  const theirRun = await seed({ agentId: a2, status: "running" });
  await seed({
    agentId: a1,
    finishedAt: new Date(NOW - HOUR).toISOString(),
    status: "done",
  });
  await seed({
    agentId: a2,
    finishedAt: new Date(NOW - HOUR).toISOString(),
    status: "done",
  });
  const waiting = await waitingOnApproval(a1);

  const mine = await view("mine", user("u1"));
  const everyone = await view("everyone", user("u1"));

  expect(mine.working.map((row) => row.id)).toEqual([mineRun]);
  expect(everyone.working.map((row) => row.id).sort()).toEqual(
    [mineRun, theirRun].sort()
  );
  expect(everyone.working.map((row) => row.id)).not.toContain(waiting.runId);
  expect(mine.doneToday).toBe(1);
  expect(everyone.doneToday).toBe(2);
});

test("a new workspace sees the two setup steps, and each goes when done", async () => {
  hasKey = false;
  const fresh = await rail.get(user("u1", "w3"), {
    dayStart: DAY_START,
    scope: "mine",
  });
  expect(fresh.setup).toEqual(["ai_account", "first_agent"]);

  hasKey = true;
  const withKey = await rail.get(user("u1", "w3"), {
    dayStart: DAY_START,
    scope: "mine",
  });
  expect(withKey.setup).toEqual(["first_agent"]);

  expect((await view()).setup).toEqual([]);
  hasKey = false;
  expect((await view()).setup).toEqual(["ai_account"]);
});

test("an Anthropic key alone clears the AI account step", async () => {
  hasKey = false;
  hasAnthropic = true;

  expect((await view()).setup).toEqual([]);
});

test("a running run with a held mail stays in Working, because no tool waits on the approval", async () => {
  const { runId } = await heldMail({ to: ["priya@acme.com"] });
  await db
    .update(runRows)
    .set({ status: "running" })
    .where(eq(runRows.id, runId));

  const result = await view("everyone");

  expect(result.needsYou).toHaveLength(1);
  expect(result.working.map((row) => row.id)).toEqual([runId]);
});

test("assignees are named from the people lookup when the member list fails", async () => {
  await setOwners(a2, "u2");
  await waitingOnApproval(a2);
  memberList = null;
  people = (ids) =>
    Promise.resolve(
      new Map(
        ids.map((id) => [id, { email: `${id}@x.com`, name: "Bob Smith" }])
      )
    );

  const [item] = (await view("everyone", user("u1"))).needsYou;

  expect(item?.assigneeUserId).toBe("u2");
  expect(item?.assigneeName).toBe("Bob Smith");
});

test("only a user can read the rail or dismiss", async () => {
  await expect(
    rail.get(system, { dayStart: DAY_START, scope: "mine" })
  ).rejects.toBeInstanceOf(ForbiddenError);
  await expect(rail.clearAttention(system, "run")).rejects.toBeInstanceOf(
    ForbiddenError
  );
});

test("the agents overview counts waiting, working and this week's tasks per agent", async () => {
  const costly = await seed({ agentId: a1, status: "running" });
  const cheap = await seed({ agentId: a1, status: "running" });
  await seed({ agentId: a2, status: "running" });
  await seed({ agentId: a2, status: "done" });
  const dry = await seed({ agentId: a2, status: "done" });
  await db
    .update(runRows)
    .set({ usage: JSON.stringify({ costUsd: 0.5, inputTokens: 10 }) })
    .where(eq(runRows.id, costly));
  await db
    .update(runRows)
    .set({ usage: JSON.stringify({ costUsd: 0.25 }) })
    .where(eq(runRows.id, cheap));
  await db.update(runRows).set({ dryRun: true }).where(eq(runRows.id, dry));
  await waitingOnApproval(a1);
  await waitingOnApproval(a1);
  const old = await seed({ agentId: a2, status: "done" });
  await db
    .update(runRows)
    .set({ createdAt: new Date(NOW - 8 * 24 * HOUR).toISOString() })
    .where(eq(runRows.id, old));

  const overview = await rail.agentsOverview(user());
  const byAgent = new Map(overview.map((row) => [row.agentId, row]));

  expect(byAgent.get(a1)).toEqual({
    agentId: a1,
    costUsdThisWeek: 0.75,
    tasksThisWeek: 4,
    waiting: 2,
    working: 2,
  });
  expect(byAgent.get(a2)).toEqual({
    agentId: a2,
    costUsdThisWeek: 0,
    tasksThisWeek: 2,
    waiting: 0,
    working: 1,
  });
});

test("the agents overview hides tasks in another member's private session", async () => {
  await seed({ agentId: a1, private: true, status: "running", userId: "u2" });
  await seed({ agentId: a1, status: "running" });

  const row = (await rail.agentsOverview(user())).find(
    (entry) => entry.agentId === a1
  );

  expect(row).toMatchObject({ tasksThisWeek: 1, working: 1 });
});

test("only a user can read the agents overview", async () => {
  await expect(rail.agentsOverview(system)).rejects.toBeInstanceOf(
    ForbiddenError
  );
});
