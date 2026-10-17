import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { migrated } from "@repo/db/test-db";
import { memoryFileBlobs } from "@repo/services/files/memory";
import { noopRelay } from "@repo/services/machines/types";
import { systemClock } from "@repo/services/runs/types";
import { bytesToBase64 } from "#/lib/library-content.ts";
import { type Composed, composeWith, type Infra } from "../compose.ts";
import { buildContext } from "./build-context.ts";
import { appRouter } from "./router.ts";

const ALLOWED_ORG_IDS = ["org_a", "org_b"];

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
  };
};

const servicesFor = (): Composed =>
  composeWith({ allowedOrgIds: ALLOWED_ORG_IDS, db, infra: infra() });

const callerFor = async (
  session: { orgId?: string | null; userId: string | null },
  composed: Composed = servicesFor()
) => appRouter.createCaller(await buildContext({ composed, session }));

test("a user creates a skill for an agent and the list shows it", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });

  expect(await caller.skills.list({ agentId: agent.id })).toEqual([]);

  const created = await caller.skills.create({
    agentId: agent.id,
    name: "write-brief",
  });
  expect(created).toEqual({ path: `skills/${agent.id}/write-brief/SKILL.md` });

  const listed = await caller.skills.list({ agentId: agent.id });
  expect(listed).toEqual([
    {
      description:
        "Describe what this skill does and when the agent should use it.",
      folder: "write-brief",
      name: "write-brief",
      path: `skills/${agent.id}/write-brief/SKILL.md`,
      problem: null,
      scope: "agent",
    },
  ]);
});

test("creating a skill with a taken name is a CONFLICT", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });
  await caller.skills.create({ agentId: agent.id, name: "write-brief" });

  await expect(
    caller.skills.create({ agentId: agent.id, name: "write-brief" })
  ).rejects.toMatchObject({ code: "CONFLICT" });
});

test("a bad skill name is a BAD_REQUEST", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });

  await expect(
    caller.skills.create({ agentId: agent.id, name: "Bad Name" })
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});

test("a caller without a session gets UNAUTHORIZED", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: null });

  await expect(caller.skills.list({ agentId: "any" })).rejects.toMatchObject({
    code: "UNAUTHORIZED",
  });
  await expect(
    caller.skills.create({ agentId: "any", name: "x" })
  ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
});

test("an agent of another workspace is NOT_FOUND", async () => {
  const composed = servicesFor();
  const other = await callerFor({ orgId: "org_b", userId: "user_2" }, composed);
  const agent = await other.agents.create({
    model: "fake",
    name: "Heron",
    runtime: "fake",
  });
  const caller = await callerFor(
    { orgId: "org_a", userId: "user_1" },
    composed
  );

  await expect(caller.skills.list({ agentId: agent.id })).rejects.toMatchObject(
    { code: "NOT_FOUND" }
  );
  await expect(
    caller.skills.create({ agentId: agent.id, name: "sneaky" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});

const skillWithFolder = async (
  caller: Awaited<ReturnType<typeof callerFor>>
) => {
  const agent = await caller.agents.create({
    model: "fake",
    name: "Pelican",
    runtime: "fake",
  });
  await caller.skills.create({ agentId: agent.id, name: "write-brief" });
  return { agentId: agent.id, scope: "agent" as const, skill: "write-brief" };
};

test("a text file written into a skill shows in its files, reads back and can be edited", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const target = await skillWithFolder(caller);

  await caller.skills.writeFile({
    ...target,
    data: "console.log('hi');\n",
    encoding: "text",
    path: "scripts/hello.ts",
  });

  const files = await caller.skills.files(target);
  expect(files.map((file) => [file.path, file.size])).toEqual([
    ["SKILL.md", expect.any(Number)],
    ["scripts/hello.ts", 19],
  ]);

  const read = await caller.skills.readFile({
    ...target,
    path: "scripts/hello.ts",
  });
  expect(read.text).toBe("console.log('hi');\n");

  await caller.skills.writeFile({
    ...target,
    data: "console.log('bye');\n",
    encoding: "text",
    path: "scripts/hello.ts",
  });
  const edited = await caller.skills.readFile({
    ...target,
    path: "scripts/hello.ts",
  });
  expect(edited.text).toBe("console.log('bye');\n");
});

test("a base64 binary file shows with its size and reads back with no text", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const target = await skillWithFolder(caller);
  const header = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]);

  await caller.skills.writeFile({
    ...target,
    data: bytesToBase64(header),
    encoding: "base64",
    path: "assets/icon.png",
  });

  const files = await caller.skills.files(target);
  expect(files.map((file) => [file.path, file.size])).toContainEqual([
    "assets/icon.png",
    header.byteLength,
  ]);

  const read = await caller.skills.readFile({
    ...target,
    path: "assets/icon.png",
  });
  expect(read.text).toBeNull();
  expect(read.entry.path).toBe(
    `skills/${target.agentId}/write-brief/assets/icon.png`
  );
});

test("a removed file leaves the skill's files", async () => {
  const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
  const target = await skillWithFolder(caller);
  await caller.skills.writeFile({
    ...target,
    data: "x",
    encoding: "text",
    path: "scripts/hello.ts",
  });

  await caller.skills.removeFile({ ...target, path: "scripts/hello.ts" });

  const files = await caller.skills.files(target);
  expect(files.map((file) => file.path)).toEqual(["SKILL.md"]);
});

test.each(["../other/SKILL.md", "/etc/passwd", "scripts/../../x", "a//b"])(
  "the file path %s is a BAD_REQUEST and adds nothing",
  async (path) => {
    const caller = await callerFor({ orgId: "org_a", userId: "user_1" });
    const target = await skillWithFolder(caller);

    await expect(
      caller.skills.writeFile({ ...target, data: "x", encoding: "text", path })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const files = await caller.skills.files(target);
    expect(files.map((file) => file.path)).toEqual(["SKILL.md"]);
  }
);

test("another workspace cannot list or read an agent's skill files", async () => {
  const composed = servicesFor();
  const owner = await callerFor({ orgId: "org_a", userId: "user_1" }, composed);
  const target = await skillWithFolder(owner);
  await owner.skills.writeFile({
    ...target,
    data: "secret",
    encoding: "text",
    path: "scripts/hello.ts",
  });
  const other = await callerFor({ orgId: "org_b", userId: "user_2" }, composed);

  await expect(other.skills.files(target)).rejects.toMatchObject({
    code: "NOT_FOUND",
  });
  await expect(
    other.skills.readFile({ ...target, path: "scripts/hello.ts" })
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
});
