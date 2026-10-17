import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions as sessionRows } from "@repo/db/schema/sessions";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { memorySkillBlobs } from "@repo/services/skills-store/memory";
import { TRPCError } from "@trpc/server";
import { bytesToBase64 } from "#/lib/library-content.ts";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ALLOWED_ORG_IDS = ["org_a", "org_b"];
const START = "2026-10-17T10:00:00.000Z";
const SKILL = "release-notes";
const ORG_A = { orgId: "org_a", userId: "user_1" };
const ORG_B = { orgId: "org_b", userId: "user_2" };
const ICON = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
const LOGO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

let db: ReturnType<typeof migrated>;

beforeEach(() => {
  db = migrated();
});

const infra = (): Infra => {
  const store = new Map<string, string>();
  return {
    atomic: sqliteAtomic(db),
    blobs: {
      get: (key) => Promise.resolve(store.get(key) ?? null),
      put: (key, body) => {
        store.set(key, body);
        return Promise.resolve();
      },
    },
    clock: systemClock,
    devFakeRuntime: true,
    fileBlobs: memoryFileBlobs(),
    relay: noopRelay,
    skillBlobs: memorySkillBlobs(),
  };
};

const servicesFor = (): Composed =>
  composeWith({ allowedOrgIds: ALLOWED_ORG_IDS, db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

type Caller = Awaited<ReturnType<typeof callerFor>>;

const skillMd = (body: string) =>
  `---\nname: ${SKILL}\ndescription: Writes release notes.\n---\n\n# ${SKILL}\n\n${body}\n`;

const textFile = (path: string, data: string) => ({
  data,
  encoding: "text" as const,
  path,
});

const binaryFile = (path: string, bytes: Uint8Array) => ({
  data: bytesToBase64(bytes),
  encoding: "base64" as const,
  path,
});

/** Version 1: SKILL.md, a text script and a binary icon. */
const createRelease = (caller: Caller) =>
  caller.skillStore.create({
    files: [
      textFile("SKILL.md", skillMd("Write the notes.")),
      textFile("scripts/old.ts", "export {};\n"),
      binaryFile("assets/icon.png", ICON),
    ],
    message: "First version",
    name: SKILL,
  });

/** The error a call rejects with, or null when it resolves. */
const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

/** Seeds a session and a run of `agentId` in the workspace, as a run needs real rows. */
const seedRun = (workspaceId: string, agentId: string): string => {
  const runId = "run_1";
  db.insert(sessionRows)
    .values({
      actorId: "user_1",
      actorKind: "user",
      agentId,
      createdAt: START,
      id: "session_1",
      origin: "ui",
      workspaceId,
    })
    .run();
  db.insert(runRows)
    .values({
      actorId: "user_1",
      actorKind: "user",
      agentId,
      createdAt: START,
      id: runId,
      inputFileIds: "[]",
      inputText: "hi",
      outputFileIds: "[]",
      sessionId: "session_1",
      status: "running",
      workspaceId,
    })
    .run();
  return runId;
};

test("a person creates a skill, which lists, logs, shows and reads back", async () => {
  const caller = await callerFor(ORG_A);
  const { skill, version } = await createRelease(caller);

  expect(version).toMatchObject({
    number: 1,
    parent: null,
    status: "approved",
  });
  expect(await caller.skillStore.list()).toEqual([
    expect.objectContaining({
      id: skill.id,
      latestApprovedVersion: 1,
      latestVersion: 1,
      name: SKILL,
      ownerAgentId: null,
    }),
  ]);
  expect(
    (await caller.skillStore.log({ skillId: skill.id })).map((v) => v.number)
  ).toEqual([1]);

  const shown = await caller.skillStore.show({
    skillId: skill.id,
    version: 1,
  });
  expect(shown.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "assets/icon.png",
    "scripts/old.ts",
  ]);

  const text = await caller.skillStore.readFile({
    path: "scripts/old.ts",
    skillId: skill.id,
    version: 1,
  });
  expect(text?.text).toBe("export {};\n");

  const binary = await caller.skillStore.readFile({
    path: "assets/icon.png",
    skillId: skill.id,
    version: 1,
  });
  expect(binary?.text).toBeNull();
  expect(binary?.size).toBe(ICON.byteLength);

  const missing = await errorOf(
    caller.skillStore.readFile({
      path: "missing.txt",
      skillId: skill.id,
      version: 1,
    })
  );
  expect(missing).toBeInstanceOf(TRPCError);
  expect((missing as TRPCError).code).toBe("NOT_FOUND");
});

test("a commit with a text write, a base64 write and a delete makes version 2, and a stale base version is a CONFLICT", async () => {
  const caller = await callerFor(ORG_A);
  const { skill } = await createRelease(caller);

  const second = await caller.skillStore.commit({
    baseVersion: 1,
    deletes: [{ path: "scripts/old.ts" }],
    message: "Add hello, new icon",
    skillId: skill.id,
    writes: [
      textFile("scripts/hello.ts", "console.log('hi');\n"),
      binaryFile("assets/icon.png", LOGO),
    ],
  });
  expect(second).toMatchObject({ number: 2, parent: 1, status: "approved" });

  const shown = await caller.skillStore.show({
    skillId: skill.id,
    version: 2,
  });
  expect(shown.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "assets/icon.png",
    "scripts/hello.ts",
  ]);
  const icon = await caller.skillStore.readFile({
    path: "assets/icon.png",
    skillId: skill.id,
    version: 2,
  });
  expect(icon?.size).toBe(LOGO.byteLength);

  const stale = await errorOf(
    caller.skillStore.commit({
      baseVersion: 1,
      deletes: [],
      message: "Built on version 1",
      skillId: skill.id,
      writes: [textFile("scripts/late.ts", "x")],
    })
  );
  expect(stale).toBeInstanceOf(TRPCError);
  expect(stale).toMatchObject({ code: "CONFLICT" });
  expect((await caller.skillStore.log({ skillId: skill.id })).length).toBe(2);
});

test("an empty commit message is a BAD_REQUEST and adds no version", async () => {
  const caller = await callerFor(ORG_A);
  const { skill } = await createRelease(caller);

  await expect(
    caller.skillStore.commit({
      baseVersion: 1,
      deletes: [],
      message: "   ",
      skillId: skill.id,
      writes: [textFile("scripts/late.ts", "x")],
    })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect((await caller.skillStore.log({ skillId: skill.id })).length).toBe(1);
});

test("diff lists what changed between two versions", async () => {
  const caller = await callerFor(ORG_A);
  const { skill } = await createRelease(caller);
  await caller.skillStore.commit({
    baseVersion: 1,
    deletes: [{ path: "scripts/old.ts" }],
    message: "Second",
    skillId: skill.id,
    writes: [
      textFile("scripts/hello.ts", "console.log('hi');\n"),
      binaryFile("assets/icon.png", LOGO),
    ],
  });

  const diff = await caller.skillStore.diff({
    from: 1,
    skillId: skill.id,
    to: 2,
  });
  expect(diff.added).toEqual(["scripts/hello.ts"]);
  expect(diff.removed).toEqual(["scripts/old.ts"]);
  expect(diff.changed).toEqual(["assets/icon.png"]);
});

test("revert makes a new version with the files of an old one", async () => {
  const caller = await callerFor(ORG_A);
  const { skill } = await createRelease(caller);
  await caller.skillStore.commit({
    baseVersion: 1,
    deletes: [{ path: "scripts/old.ts" }],
    message: "Second",
    skillId: skill.id,
    writes: [textFile("scripts/hello.ts", "console.log('hi');\n")],
  });

  const reverted = await caller.skillStore.revert({
    skillId: skill.id,
    toVersion: 1,
  });
  expect(reverted.number).toBe(3);

  const shown = await caller.skillStore.show({
    skillId: skill.id,
    version: 3,
  });
  expect(shown.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "assets/icon.png",
    "scripts/old.ts",
  ]);
});

test("a skill exported as an archive and imported back under the same name adds a version", async () => {
  const caller = await callerFor(ORG_A);
  const { skill } = await createRelease(caller);
  await caller.skillStore.commit({
    baseVersion: 1,
    deletes: [{ path: "scripts/old.ts" }],
    message: "Second",
    skillId: skill.id,
    writes: [textFile("scripts/hello.ts", "console.log('hi');\n")],
  });

  // Version 1 differs from the head (version 2), so importing it is a new version.
  const exported = await caller.skillStore.exportArchive({
    skillId: skill.id,
    version: 1,
  });
  expect(exported.filename).toBe(`${SKILL}.skill`);

  const imported = await caller.skillStore.importArchive({
    data: exported.data,
  });
  expect(imported).toMatchObject({
    created: false,
    name: SKILL,
    version: { number: 3, status: "approved" },
  });

  const shown = await caller.skillStore.show({
    skillId: skill.id,
    version: 3,
  });
  expect(shown.files.map((file) => file.path).sort()).toEqual([
    "SKILL.md",
    "assets/icon.png",
    "scripts/old.ts",
  ]);
});

test("assign, pin and unpin set the version an agent gets, and unassign removes it", async () => {
  const caller = await callerFor(ORG_A);
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });
  const { skill } = await createRelease(caller);
  await caller.skillStore.commit({
    baseVersion: 1,
    deletes: [],
    message: "Second",
    skillId: skill.id,
    writes: [textFile("SKILL.md", skillMd("Write better notes."))],
  });

  const assigned = await caller.skillStore.assign({
    agentId: agent.id,
    skillId: skill.id,
  });
  expect(assigned).toEqual({
    agentId: agent.id,
    pinnedVersion: null,
    skillId: skill.id,
  });
  expect(await caller.skillStore.assignments()).toEqual([assigned]);
  expect(await caller.skillStore.forAgent({ agentId: agent.id })).toEqual([
    expect.objectContaining({ pinned: false, skillId: skill.id, version: 2 }),
  ]);

  const pinned = await caller.skillStore.pin({
    agentId: agent.id,
    skillId: skill.id,
    version: 1,
  });
  expect(pinned.pinnedVersion).toBe(1);
  expect(await caller.skillStore.forAgent({ agentId: agent.id })).toEqual([
    expect.objectContaining({ pinned: true, skillId: skill.id, version: 1 }),
  ]);

  const unpinned = await caller.skillStore.pin({
    agentId: agent.id,
    skillId: skill.id,
    version: null,
  });
  expect(unpinned.pinnedVersion).toBeNull();
  expect(await caller.skillStore.forAgent({ agentId: agent.id })).toEqual([
    expect.objectContaining({ pinned: false, skillId: skill.id, version: 2 }),
  ]);

  await caller.skillStore.unassign({ agentId: agent.id, skillId: skill.id });
  expect(await caller.skillStore.assignments()).toEqual([]);
  expect(await caller.skillStore.forAgent({ agentId: agent.id })).toEqual([]);
});

test("a run's skill waits as a proposal until a person approves it, and a later proposal can be rejected", async () => {
  const composed = servicesFor();
  const caller = await callerFor(ORG_A, composed);
  const me = await caller.me();
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });
  const principal = {
    agentId: agent.id,
    kind: "run",
    runId: seedRun(me.workspaceId, agent.id),
    workspaceId: me.workspaceId,
  } as const;

  const drafted = await composed.services.skillsStore.create(principal, {
    files: [{ content: skillMd("Run draft."), path: "SKILL.md" }],
    message: "Agent draft",
    name: SKILL,
  });
  expect(drafted.version).toMatchObject({ number: 1, status: "proposed" });
  expect(
    (await caller.skillStore.proposals()).map((v) => [v.skillId, v.number])
  ).toEqual([[drafted.skill.id, 1]]);

  const approved = await caller.skillStore.approve({
    skillId: drafted.skill.id,
    version: 1,
  });
  expect(approved).toMatchObject({
    approvedBy: me.userId,
    number: 1,
    status: "approved",
  });
  expect(await caller.skillStore.proposals()).toEqual([]);

  await composed.services.skillsStore.commit(principal, {
    baseVersion: 1,
    deletes: [],
    message: "Agent edit",
    skillId: drafted.skill.id,
    writes: [{ content: skillMd("Run edit."), path: "SKILL.md" }],
  });
  expect(
    (await caller.skillStore.proposals()).map((v) => [v.skillId, v.number])
  ).toEqual([[drafted.skill.id, 2]]);

  const rejected = await caller.skillStore.reject({
    skillId: drafted.skill.id,
    version: 2,
  });
  expect(rejected).toMatchObject({ number: 2, status: "rejected" });
  expect(await caller.skillStore.proposals()).toEqual([]);
});

test("another organisation cannot see a skill: NOT_FOUND on log, and an empty list", async () => {
  const composed = servicesFor();
  const owner = await callerFor(ORG_A, composed);
  const { skill } = await createRelease(owner);
  const other = await callerFor(ORG_B, composed);

  await expect(
    other.skillStore.log({ skillId: skill.id })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(await other.skillStore.list()).toEqual([]);
});

test("a call without a session is UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.skillStore.list()).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(caller.skillStore.log({ skillId: "any" })).rejects.toMatchObject(
    { code: "UNAUTHORIZED" }
  );
  await expect(
    caller.skillStore.create({
      files: [textFile("SKILL.md", skillMd("x"))],
      message: "x",
      name: SKILL,
    })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});
