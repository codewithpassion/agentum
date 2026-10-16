import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { SKILLS_MAX_BYTES, SKILLS_MAX_FILES } from "@repo/protocol/skills";
import { createEventsService } from "./events.ts";
import { memoryLibraryBlobs } from "./library/memory.ts";
import { createLibraryService } from "./library.ts";
import { systemClock } from "./runs/types.ts";
import { createSkillsService } from "./skills.ts";
import type { Principal } from "./workspaces.ts";

const A = "w1";
const B = "w2";
const START = "2026-10-16T10:00:00.000Z";
const AGENT = "a1";
const OTHER_AGENT = "a2";
const RUN = "r1";

const user = (workspaceId = A): Principal => ({
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId,
});
const run = (agentId = AGENT, workspaceId = A, runId = RUN): Principal => ({
  agentId,
  kind: "run",
  runId,
  workspaceId,
});

const bytes = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

/** The error a promise rejects with, or null when it resolves. */
const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

let library: ReturnType<typeof createLibraryService>;
let skills: ReturnType<typeof createSkillsService>;

/** Writes each file with its own path as content, as the user. */
const writeAll = (list: string[]) =>
  Promise.all(list.map((path) => library.write(user(), path, bytes(path))));

const listed = async (principal: Principal = run(), runId = RUN) =>
  (await skills.list(principal, runId)).map((file) => file.path);

beforeEach(() => {
  const db = migrated();
  const blobs = memoryLibraryBlobs();
  library = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs,
    clock: systemClock,
    db,
    events: createEventsService({
      blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
      db,
    }),
  });
  skills = createSkillsService({ library });
  for (const id of [A, B]) {
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
  for (const id of [AGENT, OTHER_AGENT]) {
    db.insert(agentRows)
      .values({
        createdAt: START,
        createdBy: "u1",
        id,
        instructions: "",
        model: "m",
        name: id,
        runtime: "fake",
        runtimeConfig: "{}",
        slug: id,
        status: "active",
        workspaceId: A,
      })
      .run();
  }
});

test("own and shared skills are listed with skill-relative paths, sorted", async () => {
  await writeAll([
    "skills/_shared/shout/SKILL.md",
    "skills/_shared/shout/scripts/run.ts",
    "skills/_shared/analyse/SKILL.md",
    `skills/${AGENT}/zeta/SKILL.md`,
    `skills/${AGENT}/alpha/SKILL.md`,
  ]);

  expect(await listed()).toEqual([
    "alpha/SKILL.md",
    "analyse/SKILL.md",
    "shout/SKILL.md",
    "shout/scripts/run.ts",
    "zeta/SKILL.md",
  ]);
  const [first] = await skills.list(run(), RUN);
  expect(first).toMatchObject({
    path: "alpha/SKILL.md",
    size: bytes(`skills/${AGENT}/alpha/SKILL.md`).byteLength,
  });
  expect(first?.etag).toBeString();
});

test("an own skill with the same name as a shared one replaces it whole", async () => {
  await writeAll([
    "skills/_shared/shout/SKILL.md",
    "skills/_shared/shout/extra.md",
    `skills/${AGENT}/shout/SKILL.md`,
  ]);

  expect(await listed()).toEqual(["shout/SKILL.md"]);
  expect(decode(await skills.read(run(), RUN, "shout/SKILL.md"))).toBe(
    `skills/${AGENT}/shout/SKILL.md`
  );
  expect(
    await errorOf(skills.read(run(), RUN, "shout/extra.md"))
  ).toMatchObject({ code: "not_found" });
});

test("a read of an own skill that lacks the file is not_found, not the shared file", async () => {
  await writeAll([
    "skills/_shared/shout/SKILL.md",
    `skills/${AGENT}/shout/other.md`,
  ]);

  expect(
    await errorOf(skills.read(run(), RUN, "shout/SKILL.md"))
  ).toMatchObject({ code: "not_found" });
});

test("another agent's skills and another workspace's skills never show up or read", async () => {
  await writeAll([
    `skills/${OTHER_AGENT}/private/SKILL.md`,
    `skills/${OTHER_AGENT}/only-theirs/SKILL.md`,
    "skills/_shared/common/SKILL.md",
  ]);
  await library.write(user(B), `skills/${AGENT}/theirs/SKILL.md`, bytes("b"));
  await library.write(user(B), "skills/_shared/elsewhere/SKILL.md", bytes("b"));

  expect(await listed()).toEqual(["common/SKILL.md"]);
  expect(await listed(run(AGENT, B), RUN)).toEqual([
    "elsewhere/SKILL.md",
    "theirs/SKILL.md",
  ]);
  expect(
    await errorOf(skills.read(run(), RUN, "private/SKILL.md"))
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(skills.read(run(), RUN, "only-theirs/SKILL.md"))
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(skills.read(run(), RUN, "theirs/SKILL.md"))
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(skills.read(run(), RUN, "elsewhere/SKILL.md"))
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(skills.read(run(AGENT, B), RUN, "common/SKILL.md"))
  ).toMatchObject({ code: "not_found" });
});

test("a read that climbs out of the skill folder is refused as invalid", async () => {
  await writeAll([`skills/${OTHER_AGENT}/private/SKILL.md`]);
  const bad = [
    "",
    "shout",
    "/shout/SKILL.md",
    "\\shout/SKILL.md",
    "shout//SKILL.md",
    "shout/",
    "./shout/SKILL.md",
    "shout/./SKILL.md",
    "../a2/private/SKILL.md",
    "shout/../../a2/private/SKILL.md",
    "shout/..",
    "shout/a\u0000b",
    "shout/a\nb",
  ];
  const failures = await Promise.all(
    bad.map((path) => errorOf(skills.read(run(), RUN, path)))
  );
  for (const failure of failures) {
    expect(failure).toMatchObject({ code: "invalid" });
  }
});

test("a user principal is forbidden and a run with another run id gets not_found", async () => {
  await writeAll([`skills/${AGENT}/shout/SKILL.md`]);

  expect(await errorOf(skills.list(user(), RUN))).toMatchObject({
    message: "Not allowed: skills.list",
  });
  expect(
    await errorOf(skills.read(user(), RUN, "shout/SKILL.md"))
  ).toMatchObject({ message: "Not allowed: skills.read" });
  expect(await errorOf(skills.list(run(), "r2"))).toMatchObject({
    code: "not_found",
  });
  expect(
    await errorOf(skills.read(run(), "r2", "shout/SKILL.md"))
  ).toMatchObject({ code: "not_found" });
});

test("missing roots give an empty list", async () => {
  expect(await skills.list(run(), RUN)).toEqual([]);
  await library.write(user(), "notes/readme.md", bytes("x"));
  expect(await skills.list(run(), RUN)).toEqual([]);
});

test("a skill root with only loose files lists nothing", async () => {
  await writeAll([`skills/${AGENT}/loose.md`, "skills/_shared/loose.md"]);
  expect(await skills.list(run(), RUN)).toEqual([]);
});

test("the 200 file cap is enforced, 200 files are fine", async () => {
  const names = Array.from(
    { length: SKILLS_MAX_FILES },
    (_, index) => `skills/_shared/big/f${index}.md`
  );
  await writeAll(names);
  expect(await listed()).toHaveLength(SKILLS_MAX_FILES);

  await writeAll(["skills/_shared/big/one-more.md"]);
  expect(await errorOf(skills.list(run(), RUN))).toMatchObject({
    code: "invalid",
    message: "Skills are limited to 200 files and 5 MB",
  });
});

test("the 5 MB cap is enforced, exactly 5 MB is fine", async () => {
  const megabyte = 1024 * 1024;
  const fiveMb = SKILLS_MAX_BYTES / megabyte;
  for (let index = 0; index < fiveMb; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: keeps the writes in order
    await library.write(
      user(),
      `skills/${AGENT}/heavy/part${index}.bin`,
      new Uint8Array(megabyte)
    );
  }
  expect(await listed()).toHaveLength(fiveMb);

  await library.write(
    user(),
    `skills/${AGENT}/heavy/over.bin`,
    new Uint8Array(1)
  );
  expect(await errorOf(skills.list(run(), RUN))).toMatchObject({
    code: "invalid",
    message: "Skills are limited to 200 files and 5 MB",
  });
});

test("nested helper files are listed and readable", async () => {
  await writeAll([
    "skills/_shared/shout/SKILL.md",
    "skills/_shared/shout/lib/deep/helper.ts",
  ]);

  expect(await listed()).toEqual([
    "shout/SKILL.md",
    "shout/lib/deep/helper.ts",
  ]);
  expect(
    decode(await skills.read(run(), RUN, "shout/lib/deep/helper.ts"))
  ).toBe("skills/_shared/shout/lib/deep/helper.ts");
});
