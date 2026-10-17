import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { workspaces as workspaceRows } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { SKILLS_MAX_FILES } from "@repo/protocol/skills";
import { createAgentsService } from "./agents.ts";
import { createEventsService } from "./events.ts";
import { memoryLibraryBlobs } from "./library/memory.ts";
import { readSkillMeta, skillFileAt } from "./library/skill-file.ts";
import { createLibraryService } from "./library.ts";
import { systemClock } from "./runs/types.ts";
import { createSkillsService, type SkillScope } from "./skills.ts";
import type { Principal } from "./workspaces.ts";

const A = "w1";
const B = "w2";
const START = "2026-10-16T10:00:00.000Z";
const AGENT = "a1";
const OTHER_AGENT = "a2";
const OTHER_WORKSPACE_AGENT = "a3";

const user = (workspaceId = A): Principal => ({
  kind: "user",
  userId: "u1",
  via: "session",
  workspaceId,
});

const bytes = (value: string) => new TextEncoder().encode(value);
const decode = (value: Uint8Array) => new TextDecoder().decode(value);

/**
 * The content a file gets. A SKILL.md gets valid frontmatter for its folder,
 * since the library refuses any other, and `body` after it.
 */
const contentFor = (path: string, body: string = path): string => {
  const skill = skillFileAt(path);
  if (skill === null) {
    return body;
  }
  return `---\nname: ${skill.skill}\ndescription: A test skill.\n---\n${body}`;
};

/** The error a promise rejects with, or null when it resolves. */
const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (caught: unknown) => caught
  );

let blobs: ReturnType<typeof memoryLibraryBlobs>;
let events: ReturnType<typeof createEventsService>;
let library: ReturnType<typeof createLibraryService>;
let skills: ReturnType<typeof createSkillsService>;

/** Writes each file with its own path as content, as the user. */
const writeAll = (list: string[]) =>
  Promise.all(
    list.map((path) => library.write(user(), path, bytes(contentFor(path))))
  );

beforeEach(() => {
  const db = migrated();
  blobs = memoryLibraryBlobs();
  events = createEventsService({
    blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    db,
  });
  library = createLibraryService({
    atomic: sqliteAtomic(db),
    blobs,
    clock: systemClock,
    db,
    events,
  });
  skills = createSkillsService({
    agents: createAgentsService({ db, events }),
    library,
  });
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
  for (const [id, workspaceId] of [
    [AGENT, A],
    [OTHER_AGENT, A],
    [OTHER_WORKSPACE_AGENT, B],
  ] as const) {
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
        workspaceId,
      })
      .run();
  }
});

test("the catalog lists own then shared skills with name and description", async () => {
  await writeAll([
    "skills/_shared/shout/SKILL.md",
    "skills/_shared/analyse/SKILL.md",
    `skills/${AGENT}/zeta/SKILL.md`,
    `skills/${AGENT}/alpha/SKILL.md`,
  ]);

  const entries = await skills.catalog(user(), AGENT);
  expect(entries.map((entry) => [entry.scope, entry.folder])).toEqual([
    ["agent", "alpha"],
    ["agent", "zeta"],
    ["shared", "analyse"],
    ["shared", "shout"],
  ]);
  expect(entries[0]).toEqual({
    description: "A test skill.",
    folder: "alpha",
    name: "alpha",
    path: `skills/${AGENT}/alpha/SKILL.md`,
    problem: null,
    scope: "agent",
  });
});

test("the catalog lists a same-named skill in both scopes", async () => {
  await writeAll([
    "skills/_shared/shout/SKILL.md",
    `skills/${AGENT}/shout/SKILL.md`,
  ]);

  const entries = await skills.catalog(user(), AGENT);
  expect(entries.map((entry) => entry.scope)).toEqual(["agent", "shared"]);
  expect(entries.every((entry) => entry.problem === null)).toBe(true);
});

test("a SKILL.md that breaks a rule is listed with its problem", async () => {
  await writeAll([`skills/${AGENT}/shout/SKILL.md`]);
  // Written straight into the store, past the library's check.
  const key = `${A}/library/skills/${AGENT}/shout/SKILL.md`;
  const stored = blobs.objects.get(key);
  if (stored === undefined) {
    throw new Error("the skill file was not stored");
  }
  blobs.objects.set(key, {
    bytes: bytes("no frontmatter here"),
    etag: stored.etag,
  });

  expect(await skills.catalog(user(), AGENT)).toEqual([
    {
      description: null,
      folder: "shout",
      name: null,
      path: `skills/${AGENT}/shout/SKILL.md`,
      problem: "SKILL.md must start with a --- frontmatter block",
      scope: "agent",
    },
  ]);
});

test("a folder without SKILL.md is listed as missing", async () => {
  await writeAll([`skills/${AGENT}/helper-only/lib.ts`]);

  expect(await skills.catalog(user(), AGENT)).toEqual([
    {
      description: null,
      folder: "helper-only",
      name: null,
      path: `skills/${AGENT}/helper-only/SKILL.md`,
      problem: "SKILL.md is missing",
      scope: "agent",
    },
  ]);
});

test("the catalog of an agent of another workspace is not_found", async () => {
  await writeAll(["skills/_shared/shout/SKILL.md"]);

  expect(
    await errorOf(skills.catalog(user(), OTHER_WORKSPACE_AGENT))
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(skills.create(user(), OTHER_WORKSPACE_AGENT, "fresh"))
  ).toMatchObject({ code: "not_found" });
});

test("a new skill is written from the template and the catalog lists it", async () => {
  const created = await skills.create(user(), AGENT, "draft-report");
  expect(created).toEqual({ path: `skills/${AGENT}/draft-report/SKILL.md` });

  const [entry] = await skills.catalog(user(), AGENT);
  expect(entry).toEqual({
    description:
      "Describe what this skill does and when the agent should use it.",
    folder: "draft-report",
    name: "draft-report",
    path: `skills/${AGENT}/draft-report/SKILL.md`,
    problem: null,
    scope: "agent",
  });
  const { bytes: file } = await skills.readFile(
    user(),
    AGENT,
    "agent",
    "draft-report",
    "SKILL.md"
  );
  const text = decode(file);
  expect(readSkillMeta(text, "draft-report")).toMatchObject({
    meta: { name: "draft-report" },
  });
});

test("a name of 64 characters is accepted", async () => {
  const name = "a".repeat(64);
  await expect(skills.create(user(), AGENT, name)).resolves.toEqual({
    path: `skills/${AGENT}/${name}/SKILL.md`,
  });
});

test("creating a skill twice is a conflict", async () => {
  await skills.create(user(), AGENT, "draft-report");

  expect(
    await errorOf(skills.create(user(), AGENT, "draft-report"))
  ).toMatchObject({
    code: "conflict",
    message: "A skill with this name already exists",
  });
});

test("a name that is not a lowercase slug is refused and writes nothing", async () => {
  const bad = ["Bad Name", "-x", "a--b", "", "a".repeat(65), "../x"];
  const failures = await Promise.all(
    bad.map((name) => errorOf(skills.create(user(), AGENT, name)))
  );
  for (const failure of failures) {
    expect(failure).toMatchObject({
      code: "invalid",
      message:
        "Skill names use lowercase letters, digits and single hyphens, up to 64 characters",
    });
  }
  expect(await skills.catalog(user(), AGENT)).toEqual([]);
  expect(blobs.objects.size).toBe(0);
});

const AGENT_SKILL = `skills/${AGENT}/shout/SKILL.md`;

const treePaths = async (scope: SkillScope = "agent", skill = "shout") =>
  (await skills.tree(user(), AGENT, scope, skill)).map((file) => file.path);

test("a file written under a skill shows up in its tree", async () => {
  await writeAll([AGENT_SKILL]);
  await skills.writeFile(
    user(),
    AGENT,
    "agent",
    "shout",
    "scripts/hello.ts",
    bytes("print")
  );

  expect(await treePaths()).toEqual(["SKILL.md", "scripts/hello.ts"]);
  const [, hello] = await skills.tree(user(), AGENT, "agent", "shout");
  expect(hello).toEqual({
    etag: expect.any(String),
    path: "scripts/hello.ts",
    size: bytes("print").byteLength,
  });
});

test("an edit changes the bytes readFile returns, SKILL.md included", async () => {
  await writeAll([AGENT_SKILL]);
  await skills.writeFile(
    user(),
    AGENT,
    "agent",
    "shout",
    "scripts/hello.ts",
    bytes("v1")
  );
  await skills.writeFile(
    user(),
    AGENT,
    "agent",
    "shout",
    "scripts/hello.ts",
    bytes("v2")
  );
  await skills.writeFile(
    user(),
    AGENT,
    "agent",
    "shout",
    "SKILL.md",
    bytes(contentFor(AGENT_SKILL, "edited"))
  );

  const { bytes: hello } = await skills.readFile(
    user(),
    AGENT,
    "agent",
    "shout",
    "scripts/hello.ts"
  );
  expect(decode(hello)).toBe("v2");
  const { bytes: skill } = await skills.readFile(
    user(),
    AGENT,
    "agent",
    "shout",
    "SKILL.md"
  );
  expect(decode(skill)).toBe(contentFor(AGENT_SKILL, "edited"));
});

test("removeFile takes the file out of the tree and refuses a folder", async () => {
  await writeAll([AGENT_SKILL]);
  await skills.writeFile(
    user(),
    AGENT,
    "agent",
    "shout",
    "scripts/hello.ts",
    bytes("v1")
  );

  await skills.removeFile(user(), AGENT, "agent", "shout", "scripts/hello.ts");
  expect(await treePaths()).toEqual(["SKILL.md"]);
  expect(
    await errorOf(
      skills.readFile(user(), AGENT, "agent", "shout", "scripts/hello.ts")
    )
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(skills.removeFile(user(), AGENT, "agent", "shout", "scripts"))
  ).toMatchObject({ code: "invalid" });
  expect(
    await errorOf(skills.removeFile(user(), AGENT, "agent", "shout", "gone.ts"))
  ).toMatchObject({ code: "not_found" });
});

test("a path that could leave the skill folder is refused and writes nothing", async () => {
  await writeAll([AGENT_SKILL, `skills/${OTHER_AGENT}/private/SKILL.md`]);
  const before = new Map(blobs.objects);
  const bad = [
    "",
    "..",
    "../private/SKILL.md",
    "/etc/x",
    "a/../../b",
    "scripts//x.ts",
    "scripts/./x.ts",
    "scripts/",
    "scripts\\x.ts",
    "scripts\\..\\x.ts",
    "scripts/a\u0000b.ts",
  ];
  const failures = await Promise.all(
    bad.flatMap((path) => [
      errorOf(
        skills.writeFile(user(), AGENT, "agent", "shout", path, bytes("x"))
      ),
      errorOf(skills.readFile(user(), AGENT, "agent", "shout", path)),
      errorOf(skills.removeFile(user(), AGENT, "agent", "shout", path)),
    ])
  );
  for (const failure of failures) {
    expect(failure).toMatchObject({ code: "invalid" });
  }
  expect(blobs.objects).toEqual(before);
  expect(await treePaths()).toEqual(["SKILL.md"]);
});

test("a missing skill folder is not_found and an unsafe skill folder name is invalid", async () => {
  await writeAll([AGENT_SKILL]);

  expect(
    await errorOf(skills.tree(user(), AGENT, "agent", "ghost"))
  ).toMatchObject({
    code: "not_found",
  });
  expect(
    await errorOf(skills.readFile(user(), AGENT, "agent", "ghost", "a.ts"))
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(
      skills.writeFile(user(), AGENT, "agent", "ghost", "a.ts", bytes("x"))
    )
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(skills.removeFile(user(), AGENT, "agent", "ghost", "a.ts"))
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(skills.tree(user(), AGENT, "shared", "shout"))
  ).toMatchObject({ code: "not_found" });

  const bad = ["../shout", "a/b", "", "a\\b", ".."];
  const failures = await Promise.all(
    bad.map((name) => errorOf(skills.tree(user(), AGENT, "agent", name)))
  );
  for (const failure of failures) {
    expect(failure).toMatchObject({
      code: "invalid",
      message: "Skill folder name is not valid",
    });
  }
  // A folder the catalog lists stays reachable even when its name breaks the naming rule.
  await writeAll([`skills/${AGENT}/Odd_Name/notes.md`]);
  expect(await treePaths("agent", "Odd_Name")).toEqual(["notes.md"]);
});

test("the 200 file cap refuses a 201st file and writes nothing", async () => {
  const names = Array.from(
    { length: SKILLS_MAX_FILES - 1 },
    (_, index) => `skills/_shared/big/f${index}.md`
  );
  await writeAll(["skills/_shared/big/SKILL.md", ...names]);
  expect(await treePaths("shared", "big")).toHaveLength(SKILLS_MAX_FILES);

  await skills.writeFile(user(), AGENT, "shared", "big", "f0.md", bytes("new"));
  expect(
    await errorOf(
      skills.writeFile(
        user(),
        AGENT,
        "shared",
        "big",
        "one-more.md",
        bytes("x")
      )
    )
  ).toMatchObject({
    code: "invalid",
    message: "Skills are limited to 200 files and 5 MB",
  });
  expect(await treePaths("shared", "big")).toHaveLength(SKILLS_MAX_FILES);
});

test("the caps hold for all of an agent's skills together, and a hidden shared skill does not count", async () => {
  const first = Array.from(
    { length: 150 },
    (_, index) => `skills/${AGENT}/one/f${index}.md`
  );
  await writeAll([`skills/${AGENT}/one/SKILL.md`, ...first]);
  await writeAll([
    "skills/_shared/hidden/SKILL.md",
    "skills/_shared/hidden/a.md",
  ]);
  await writeAll([`skills/${AGENT}/two/SKILL.md`]);

  const fill = Array.from({ length: 46 }, (_, index) => `f${index}.md`);
  for (const name of fill) {
    // biome-ignore lint/performance/noAwaitInLoops: keeps the writes in order
    await skills.writeFile(user(), AGENT, "agent", "two", name, bytes("x"));
  }
  // 151 + 2 (shared, not yet hidden) + 47 = 200 files across skills, though no skill has more than 151.
  expect(
    await errorOf(
      skills.writeFile(user(), AGENT, "agent", "two", "over.md", bytes("x"))
    )
  ).toMatchObject({
    code: "invalid",
    message: "Skills are limited to 200 files and 5 MB",
  });

  // The agent's own skill of the same name hides the shared one, so a shared write is not counted for it.
  await writeAll([`skills/${AGENT}/hidden/SKILL.md`]);
  await skills.writeFile(user(), AGENT, "shared", "hidden", "b.md", bytes("x"));
  expect(await treePaths("shared", "hidden")).toContain("b.md");
});

test("a shared write is checked for every agent that sees the skill", async () => {
  const names = Array.from(
    { length: 195 },
    (_, index) => `skills/${OTHER_AGENT}/mine/f${index}.md`
  );
  await writeAll([`skills/${OTHER_AGENT}/mine/SKILL.md`, ...names]);
  await writeAll(["skills/_shared/team/SKILL.md"]);
  await writeAll([`skills/${AGENT}/team/SKILL.md`]);

  const extra = (count: number) =>
    Array.from({ length: count }, (_, index) => `x${index}.md`);
  // AGENT hides the shared "team" skill, but OTHER_AGENT sees it: 196 + 1 + 3 = 200.
  for (const name of extra(3)) {
    // biome-ignore lint/performance/noAwaitInLoops: keeps the writes in order
    await skills.writeFile(user(), AGENT, "shared", "team", name, bytes("x"));
  }
  expect(
    await errorOf(
      skills.writeFile(user(), AGENT, "shared", "team", "over.md", bytes("x"))
    )
  ).toMatchObject({
    code: "invalid",
    message: "Skills are limited to 200 files and 5 MB",
  });
  expect(await treePaths("shared", "team")).not.toContain("over.md");
});

test("the 5 MB cap refuses a write that goes over and writes nothing", async () => {
  const megabyte = 1024 * 1024;
  await writeAll([`skills/${AGENT}/heavy/SKILL.md`]);
  for (let index = 0; index < 4; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: keeps the writes in order
    await library.write(
      user(),
      `skills/${AGENT}/heavy/part${index}.bin`,
      new Uint8Array(megabyte)
    );
  }

  expect(
    await errorOf(
      skills.writeFile(
        user(),
        AGENT,
        "agent",
        "heavy",
        "over.bin",
        new Uint8Array(megabyte)
      )
    )
  ).toMatchObject({
    code: "invalid",
    message: "Skills are limited to 200 files and 5 MB",
  });
  expect(await treePaths("agent", "heavy")).toHaveLength(5);
});

test("a stale ifEtag gives conflict and keeps the newer bytes", async () => {
  await writeAll([AGENT_SKILL]);
  const first = await skills.writeFile(
    user(),
    AGENT,
    "agent",
    "shout",
    "scripts/hello.ts",
    bytes("v1")
  );
  const stale = first.etag;
  if (stale === null) {
    throw new Error("a written file has an etag");
  }
  await skills.writeFile(
    user(),
    AGENT,
    "agent",
    "shout",
    "scripts/hello.ts",
    bytes("v2"),
    { ifEtag: stale }
  );

  expect(
    await errorOf(
      skills.writeFile(
        user(),
        AGENT,
        "agent",
        "shout",
        "scripts/hello.ts",
        bytes("v3"),
        { ifEtag: stale }
      )
    )
  ).toMatchObject({ code: "conflict" });
  const { bytes: hello } = await skills.readFile(
    user(),
    AGENT,
    "agent",
    "shout",
    "scripts/hello.ts"
  );
  expect(decode(hello)).toBe("v2");
});

test("another workspace's agent is refused as agents.get refuses it", async () => {
  await writeAll([AGENT_SKILL]);

  expect(
    await errorOf(skills.tree(user(), OTHER_WORKSPACE_AGENT, "agent", "shout"))
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(
      skills.writeFile(
        user(),
        OTHER_WORKSPACE_AGENT,
        "agent",
        "shout",
        "a.ts",
        bytes("x")
      )
    )
  ).toMatchObject({ code: "not_found" });
  expect(
    await errorOf(
      skills.removeFile(user(), OTHER_WORKSPACE_AGENT, "agent", "shout", "a.ts")
    )
  ).toMatchObject({ code: "not_found" });
});

test("shared scope writes under skills/_shared/", async () => {
  await writeAll(["skills/_shared/shout/SKILL.md"]);

  await skills.writeFile(
    user(),
    AGENT,
    "shared",
    "shout",
    "lib/helper.ts",
    bytes("export {}")
  );
  expect(await treePaths("shared")).toEqual(["SKILL.md", "lib/helper.ts"]);
  expect(
    decode(
      (await library.read(user(), "skills/_shared/shout/lib/helper.ts")).bytes
    )
  ).toBe("export {}");
  expect(
    decode(
      (await skills.readFile(user(), AGENT, "shared", "shout", "lib/helper.ts"))
        .bytes
    )
  ).toBe("export {}");

  await skills.removeFile(user(), AGENT, "shared", "shout", "lib/helper.ts");
  expect(await treePaths("shared")).toEqual(["SKILL.md"]);
  expect(
    await errorOf(skills.tree(user(), AGENT, "agent", "shout"))
  ).toMatchObject({
    code: "not_found",
  });
});
