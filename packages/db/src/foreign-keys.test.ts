import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents } from "./schema/agents.ts";
import {
  agentLibraryAccess,
  libraryConflicts,
  libraryLinks,
  libraryVersions,
  wikiSuggestions,
} from "./schema/library.ts";
import { agentMailboxes, mailMessages, mailThreads } from "./schema/mail.ts";
import { runRequests } from "./schema/requests.ts";
import { runs } from "./schema/runs.ts";
import { sessions } from "./schema/sessions.ts";
import { agentToolRules } from "./schema/tool-rules.ts";
import { triggers } from "./schema/triggers.ts";
import { workspaces } from "./schema/workspaces.ts";
import { migrated } from "./test-db.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const workspace = (id: string) => ({
  clerkOrgId: `org_${id}`,
  createdAt: NOW,
  id,
  name: id,
  timezone: "UTC",
});

const agent = (id: string, workspaceId: string) => ({
  createdAt: NOW,
  createdBy: "u1",
  id,
  instructions: "",
  model: "m",
  name: id,
  runtime: "fake" as const,
  runtimeConfig: "{}",
  slug: id,
  status: "active",
  workspaceId,
});

test("an insert with an unknown workspace_id throws", () => {
  const db = migrated();
  expect(() => db.insert(agents).values(agent("a1", "nope")).run()).toThrow(
    "FOREIGN KEY constraint failed"
  );
});

test("an insert with an unknown nullable reference throws, and null is fine", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  expect(() =>
    db
      .insert(agents)
      .values({ ...agent("a1", "w1"), machineId: "nope" })
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
  db.insert(agents).values(agent("a2", "w1")).run();
  expect(db.select().from(agents).all()).toHaveLength(1);
});

test("deleting a referenced workspace throws", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents).values(agent("a1", "w1")).run();
  expect(() =>
    db.delete(workspaces).where(eq(workspaces.id, "w1")).run()
  ).toThrow("FOREIGN KEY constraint failed");
  expect(db.select().from(workspaces).all()).toHaveLength(1);
});

test("deleting an agent cascades to its triggers", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents).values(agent("a1", "w1")).run();
  db.insert(triggers)
    .values({
      agentId: "a1",
      createdAt: NOW,
      createdBy: "u1",
      id: "t1",
      kind: "http",
      name: "t",
      tokenHash: "h",
      tokenPrefix: "hm_trg_abcd",
      workspaceId: "w1",
    })
    .run();
  db.delete(agents).where(eq(agents.id, "a1")).run();
  expect(db.select().from(triggers).all()).toHaveLength(0);
});

const seedRun = (db: ReturnType<typeof migrated>) => {
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents).values(agent("a1", "w1")).run();
  db.insert(sessions)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: "a1",
      createdAt: NOW,
      id: "s1",
      origin: "ui",
      workspaceId: "w1",
    })
    .run();
  db.insert(runs)
    .values({
      actorId: "u1",
      actorKind: "user",
      agentId: "a1",
      createdAt: NOW,
      id: "r1",
      inputText: "hi",
      sessionId: "s1",
      status: "waiting",
      workspaceId: "w1",
    })
    .run();
};

const request = (overrides: Partial<typeof runRequests.$inferInsert> = {}) => ({
  agentId: "a1",
  createdAt: NOW,
  display: "{}",
  expiresAt: NOW,
  id: "q1",
  kind: "approval" as const,
  runId: "r1",
  sessionId: "s1",
  status: "pending" as const,
  toolName: "Bash",
  toolUseId: "tu1",
  workspaceId: "w1",
  ...overrides,
});

test("a request stores a waiting run, refuses a second row for the same tool use, and refuses an unknown run or agent", () => {
  const db = migrated();
  seedRun(db);
  db.insert(runRequests).values(request()).run();
  expect(() =>
    db
      .insert(runRequests)
      .values(request({ id: "q2" }))
      .run()
  ).toThrow("UNIQUE constraint failed");
  db.insert(runRequests)
    .values(request({ id: "q3", toolUseId: "tu2" }))
    .run();
  expect(() =>
    db
      .insert(runRequests)
      .values(request({ id: "q4", runId: "nope", toolUseId: "tu3" }))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
  expect(() =>
    db
      .insert(runRequests)
      .values(request({ agentId: "nope", id: "q5", toolUseId: "tu4" }))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
});

test("a tool rule is unique per agent and tool key, and refuses an unknown agent", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents).values(agent("a1", "w1")).run();
  const rule = (id: string, agentId: string, toolKey: string) => ({
    agentId,
    id,
    mode: "ask" as const,
    toolKey,
    updatedAt: NOW,
    updatedBy: "u1",
    workspaceId: "w1",
  });
  db.insert(agentToolRules)
    .values(rule("t1", "a1", "Bash"))
    .run();
  db.insert(agentToolRules)
    .values(rule("t2", "a1", "Write"))
    .run();
  expect(() =>
    db
      .insert(agentToolRules)
      .values(rule("t3", "a1", "Bash"))
      .run()
  ).toThrow("UNIQUE constraint failed");
  expect(() =>
    db
      .insert(agentToolRules)
      .values(rule("t4", "nope", "Bash"))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
});

const version = (
  overrides: Partial<typeof libraryVersions.$inferInsert> = {}
) => ({
  authorId: "a1",
  authorKind: "agent",
  blobKey: "w1/library-versions/v1",
  createdAt: NOW,
  etag: "e",
  id: "v1",
  op: "write" as const,
  path: "wiki/index.md",
  runId: "r1",
  sha256: "abc",
  size: 3,
  version: 1,
  workspaceId: "w1",
  ...overrides,
});

test("a library version refuses an unknown run or workspace and a repeated version of a path, and takes a null run", () => {
  const db = migrated();
  seedRun(db);
  db.insert(libraryVersions).values(version()).run();
  db.insert(libraryVersions)
    .values(version({ id: "v2", runId: null, version: 2 }))
    .run();
  expect(() =>
    db
      .insert(libraryVersions)
      .values(version({ id: "v3" }))
      .run()
  ).toThrow("UNIQUE constraint failed");
  expect(() =>
    db
      .insert(libraryVersions)
      .values(version({ id: "v4", runId: "nope", version: 3 }))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
  expect(() =>
    db
      .insert(libraryVersions)
      .values(version({ id: "v5", version: 4, workspaceId: "nope" }))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
});

test("an access grant is unique per agent and path, and refuses an unknown agent", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  db.insert(agents).values(agent("a1", "w1")).run();
  const grant = (agentId: string, path: string) => ({
    agentId,
    createdAt: NOW,
    mode: "read" as const,
    path,
    workspaceId: "w1",
  });
  db.insert(agentLibraryAccess).values(grant("a1", "shared")).run();
  db.insert(agentLibraryAccess).values(grant("a1", "clients")).run();
  expect(() =>
    db.insert(agentLibraryAccess).values(grant("a1", "shared")).run()
  ).toThrow("UNIQUE constraint failed");
  expect(() =>
    db.insert(agentLibraryAccess).values(grant("nope", "shared")).run()
  ).toThrow("FOREIGN KEY constraint failed");
});

test("a conflict refuses an unknown agent or run, and takes a null run", () => {
  const db = migrated();
  seedRun(db);
  const conflict = (
    overrides: Partial<typeof libraryConflicts.$inferInsert> = {}
  ) => ({
    agentId: "a1",
    conflictPath: "notes.md.conflict-r1",
    createdAt: NOW,
    id: "c1",
    path: "notes.md",
    runId: "r1",
    status: "open" as const,
    workspaceId: "w1",
    ...overrides,
  });
  db.insert(libraryConflicts).values(conflict()).run();
  db.insert(libraryConflicts)
    .values(conflict({ id: "c2", runId: null }))
    .run();
  expect(() =>
    db
      .insert(libraryConflicts)
      .values(conflict({ agentId: "nope", id: "c3" }))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
  expect(() =>
    db
      .insert(libraryConflicts)
      .values(conflict({ id: "c4", runId: "nope" }))
      .run()
  ).toThrow("FOREIGN KEY constraint failed");
});

test("a link is unique per page and target as written, and refuses an unknown workspace", () => {
  const db = migrated();
  db.insert(workspaces).values(workspace("w1")).run();
  const link = (target: string, workspaceId = "w1") => ({
    fromPath: "wiki/a.md",
    target,
    targetKey: "wiki/b.md",
    workspaceId,
  });
  db.insert(libraryLinks).values(link("b")).run();
  db.insert(libraryLinks).values(link("B")).run();
  expect(() => db.insert(libraryLinks).values(link("b")).run()).toThrow(
    "UNIQUE constraint failed"
  );
  expect(() => db.insert(libraryLinks).values(link("c", "nope")).run()).toThrow(
    "FOREIGN KEY constraint failed"
  );
});

test("a suggestion refuses an unknown agent, run or version, and takes null references", () => {
  const db = migrated();
  seedRun(db);
  db.insert(libraryVersions).values(version()).run();
  const suggestion = (
    overrides: Partial<typeof wikiSuggestions.$inferInsert> = {}
  ) => ({
    agentId: "a1",
    baseVersionId: "v1",
    blobKey: "w1/wiki-suggestions/s1",
    createdAt: NOW,
    id: "s1",
    path: "wiki/index.md",
    runId: "r1",
    status: "pending" as const,
    summary: "Fix a typo",
    workspaceId: "w1",
    ...overrides,
  });
  db.insert(wikiSuggestions).values(suggestion()).run();
  db.insert(wikiSuggestions)
    .values(suggestion({ baseVersionId: null, id: "s2", runId: null }))
    .run();
  for (const [id, overrides] of [
    ["s3", { agentId: "nope" }],
    ["s4", { runId: "nope" }],
    ["s5", { baseVersionId: "nope" }],
    ["s6", { resultVersionId: "nope" }],
  ] as const) {
    expect(() =>
      db
        .insert(wikiSuggestions)
        .values(suggestion({ id, ...overrides }))
        .run()
    ).toThrow("FOREIGN KEY constraint failed");
  }
});

test("deleting a version a suggestion points at clears the reference", () => {
  const db = migrated();
  seedRun(db);
  db.insert(libraryVersions).values(version()).run();
  db.insert(wikiSuggestions)
    .values({
      agentId: "a1",
      baseVersionId: "v1",
      blobKey: "w1/wiki-suggestions/s1",
      createdAt: NOW,
      id: "s1",
      path: "wiki/index.md",
      resultVersionId: "v1",
      status: "accepted",
      summary: "Fix a typo",
      workspaceId: "w1",
    })
    .run();
  db.delete(libraryVersions).where(eq(libraryVersions.id, "v1")).run();
  const [row] = db.select().from(wikiSuggestions).all();
  expect(row?.baseVersionId).toBeNull();
  expect(row?.resultVersionId).toBeNull();
});

const mailbox = (
  overrides: Partial<typeof agentMailboxes.$inferInsert> = {}
) => ({
  address: "ada@mail.example.com",
  agentId: "a1",
  createdAt: NOW,
  id: "mb1",
  status: "provisioning" as const,
  workspaceId: "w1",
  ...overrides,
});

const mailThread = (
  overrides: Partial<typeof mailThreads.$inferInsert> = {}
) => ({
  externalThreadId: "t-ext-1",
  id: "mt1",
  lastMessageAt: NOW,
  mailboxId: "mb1",
  subject: "Hello",
  workspaceId: "w1",
  ...overrides,
});

const mailMessage = (
  overrides: Partial<typeof mailMessages.$inferInsert> = {}
) => ({
  ccAddresses: "[]",
  createdAt: NOW,
  direction: "in" as const,
  externalMessageId: "m-ext-1",
  fromAddress: "sam@example.com",
  id: "mm1",
  snippet: "Hi there",
  status: "received" as const,
  subject: "Hello",
  threadId: "mt1",
  toAddresses: '["ada@mail.example.com"]',
  workspaceId: "w1",
  ...overrides,
});

test("a mailbox is unique per agent and per address, and refuses an unknown agent or workspace", () => {
  const db = migrated();
  seedRun(db);
  db.insert(agents).values(agent("a2", "w1")).run();
  db.insert(agentMailboxes).values(mailbox()).run();
  expect(() =>
    db
      .insert(agentMailboxes)
      .values(mailbox({ address: "other@mail.example.com", id: "mb2" }))
      .run()
  ).toThrow("UNIQUE constraint failed");
  expect(() =>
    db
      .insert(agentMailboxes)
      .values(mailbox({ agentId: "a2", id: "mb3" }))
      .run()
  ).toThrow("UNIQUE constraint failed");
  for (const overrides of [{ agentId: "nope" }, { workspaceId: "nope" }]) {
    expect(() =>
      db
        .insert(agentMailboxes)
        .values(
          mailbox({
            address: "x@mail.example.com",
            agentId: "a2",
            id: "mb4",
            ...overrides,
          })
        )
        .run()
    ).toThrow("FOREIGN KEY constraint failed");
  }
});

test("a mail thread is unique per mailbox and external thread, and takes a null session", () => {
  const db = migrated();
  seedRun(db);
  db.insert(agentMailboxes).values(mailbox()).run();
  db.insert(mailThreads).values(mailThread()).run();
  expect(() =>
    db
      .insert(mailThreads)
      .values(mailThread({ id: "mt2" }))
      .run()
  ).toThrow("UNIQUE constraint failed");
  db.insert(mailThreads)
    .values(
      mailThread({ externalThreadId: "t-ext-2", id: "mt3", sessionId: "s1" })
    )
    .run();
  for (const overrides of [
    { mailboxId: "nope" },
    { sessionId: "nope" },
    { workspaceId: "nope" },
  ]) {
    expect(() =>
      db
        .insert(mailThreads)
        .values(
          mailThread({ externalThreadId: "t-ext-3", id: "mt4", ...overrides })
        )
        .run()
    ).toThrow("FOREIGN KEY constraint failed");
  }
});

test("a mail message is unique per thread and external id, and refuses an unknown thread, run, request or workspace", () => {
  const db = migrated();
  seedRun(db);
  db.insert(runRequests).values(request()).run();
  db.insert(agentMailboxes).values(mailbox()).run();
  db.insert(mailThreads).values(mailThread()).run();
  db.insert(mailMessages).values(mailMessage()).run();
  expect(() =>
    db
      .insert(mailMessages)
      .values(mailMessage({ id: "mm2" }))
      .run()
  ).toThrow("UNIQUE constraint failed");
  db.insert(mailMessages)
    .values(
      mailMessage({
        direction: "out",
        externalMessageId: "m-ext-2",
        id: "mm3",
        requestId: "q1",
        rfcMessageId: "<abc@mail.example.com>",
        runId: "r1",
        status: "held",
      })
    )
    .run();
  for (const overrides of [
    { threadId: "nope" },
    { runId: "nope" },
    { requestId: "nope" },
    { workspaceId: "nope" },
  ]) {
    expect(() =>
      db
        .insert(mailMessages)
        .values(
          mailMessage({ externalMessageId: "m-ext-3", id: "mm4", ...overrides })
        )
        .run()
    ).toThrow("FOREIGN KEY constraint failed");
  }
});
