import { beforeEach, expect, test } from "bun:test";
import { events as eventRows } from "@repo/db/schema/events";
import { libraryEntries } from "@repo/db/schema/library";
import {
  skillAssignments,
  skillLibraryMigrations,
  skills,
  skillVersionFiles,
  skillVersions,
} from "@repo/db/schema/skills";
import { eq } from "drizzle-orm";
import { systemClock } from "../runs/types.ts";
import { createSkillsStoreService } from "../skills-store.ts";
import {
  A1,
  A2,
  B1,
  bytes,
  decode,
  run,
  setup,
  skillMd,
  user,
  W2,
} from "./test-support.ts";

let env: ReturnType<typeof setup>;

const put = (path: string, text: string, principal = user()) =>
  env.library.write(principal, path, bytes(text));

const counts = () => ({
  assignments: env.db.select().from(skillAssignments).all().length,
  events: env.db.select().from(eventRows).all().length,
  files: env.db.select().from(skillVersionFiles).all().length,
  libraryRows: env.db.select().from(libraryEntries).all().length,
  markers: env.db.select().from(skillLibraryMigrations).all().length,
  skills: env.db.select().from(skills).all().length,
  versions: env.db.select().from(skillVersions).all().length,
});

beforeEach(async () => {
  env = setup();
  await put("skills/a1/own-skill/SKILL.md", skillMd("own-skill"));
  await put("skills/a1/own-skill/scripts/run.sh", "echo own\n");
  await put("skills/a1/dup/SKILL.md", skillMd("dup", "Agent one's own."));
  await put("skills/a2/a2-only/SKILL.md", skillMd("a2-only"));
  await put("skills/_shared/team/SKILL.md", skillMd("team"));
  await put("skills/_shared/dup/SKILL.md", skillMd("dup", "The shared one."));
  await put("skills/a1/broken/readme.txt", "no skill file here");
  await put("skills/_shared/Bad Name/SKILL.md", skillMd("Bad Name"));
  await put("skills/ghost/orphan/SKILL.md", skillMd("orphan"));
  await put("skills/b1/other/SKILL.md", skillMd("other"), user(W2));
});

test("the migration turns each folder into a skill and reports the folders it skipped", async () => {
  const result = await env.service.migrateLibrary(user());

  expect(result.migrated).toBe(5);
  expect(result.skipped.map((entry) => entry.path).sort()).toEqual([
    "skills/_shared/Bad Name",
    "skills/a1/broken",
  ]);
  const listed = await env.service.list(user());
  expect(
    listed
      .map((skill) => `${skill.name}:${skill.ownerAgentId ?? "people"}`)
      .sort()
  ).toEqual([
    `a2-only:${A2}`,
    `dup:${A1}`,
    "dup:people",
    `own-skill:${A1}`,
    "team:people",
  ]);
  const logs = await Promise.all(
    listed.map((skill) => env.service.log(user(), { skillId: skill.id }))
  );
  for (const [index, skill] of listed.entries()) {
    expect(skill.latestVersion).toBe(1);
    expect(skill.latestApprovedVersion).toBe(1);
    expect(logs[index]).toMatchObject([
      {
        approvedBy: "migration",
        author: { id: "migration", kind: "system" },
        number: 1,
        parent: null,
        status: "approved",
      },
    ]);
  }
});

test("own skills go to their agent and shared ones to every agent that has no own skill of the name", async () => {
  await env.service.migrateLibrary(user());

  const one = await env.service.forAgent(user(), A1, { withContents: true });
  const two = await env.service.forAgent(user(), A2, { withContents: true });

  expect(one.map((skill) => skill.name)).toEqual(["dup", "own-skill", "team"]);
  expect(two.map((skill) => skill.name)).toEqual(["a2-only", "dup", "team"]);
  const contentOf = (skill: (typeof one)[number] | undefined) =>
    decode(
      skill?.files.find((file) => file.path === "SKILL.md")?.content ??
        new Uint8Array()
    );
  expect(contentOf(one.find((skill) => skill.name === "dup"))).toContain(
    "Agent one's own."
  );
  expect(contentOf(two.find((skill) => skill.name === "dup"))).toContain(
    "The shared one."
  );
  expect(one.every((skill) => skill.version === 1 && !skill.pinned)).toBe(true);
});

test("files below a skill folder come along", async () => {
  await env.service.migrateLibrary(user());
  const own = (await env.service.list(user())).find(
    (skill) => skill.name === "own-skill"
  );

  const shown = await env.service.show(user(), {
    skillId: own?.id ?? "",
    version: 1,
    withContents: true,
  });

  expect(shown.files.map((file) => file.path)).toEqual([
    "SKILL.md",
    "scripts/run.sh",
  ]);
  expect(
    decode(
      shown.files.find((file) => file.path === "scripts/run.sh")?.content ??
        new Uint8Array()
    )
  ).toBe("echo own\n");
});

test("a second run changes nothing, on the same service and on a new one", async () => {
  await env.service.migrateLibrary(user());
  const before = counts();

  const again = await env.service.migrateLibrary(user());
  const fresh = createSkillsStoreService({
    atomic: env.atomic,
    blobs: env.blobs,
    clock: systemClock,
    db: env.db,
    events: env.events,
    library: env.library,
  });
  const third = await fresh.migrateLibrary(user());

  expect(again).toEqual({ migrated: 0, skipped: [] });
  expect(third).toEqual({ migrated: 0, skipped: [] });
  expect(counts()).toEqual(before);
});

test("the first call of any method migrates, for a person and for a run", async () => {
  const resolved = await env.service.forAgent(run(A1), A1);

  expect(resolved.map((skill) => skill.name)).toEqual([
    "dup",
    "own-skill",
    "team",
  ]);
  expect(counts().markers).toBe(1);
});

test("a workspace is migrated on its own first access", async () => {
  await env.service.list(user());
  expect(counts().markers).toBe(1);

  const other = await env.service.forAgent(user(W2), B1);

  expect(other.map((skill) => skill.name)).toEqual(["other"]);
  expect(counts().markers).toBe(2);
  const w1Names = (await env.service.list(user())).map((skill) => skill.name);
  expect(w1Names).not.toContain("other");
});

test("the library stays as it was, and later library changes are not read", async () => {
  const before = env.db.select().from(libraryEntries).all();
  await env.service.migrateLibrary(user());
  expect(env.db.select().from(libraryEntries).all()).toEqual(before);

  await put("skills/a1/late/SKILL.md", skillMd("late"));
  await env.service.list(user());

  const names = (await env.service.list(user())).map((skill) => skill.name);
  expect(names).not.toContain("late");
});

test("migrated skills take commits like any other", async () => {
  await env.service.migrateLibrary(user());
  const team = (await env.service.list(user())).find(
    (skill) => skill.name === "team"
  );

  const version = await env.service.commit(user(), {
    baseVersion: 1,
    message: "Tweak",
    skillId: team?.id ?? "",
    writes: [{ content: skillMd("team", "Changed."), path: "SKILL.md" }],
  });

  expect(version.number).toBe(2);
  const resolved = await env.service.forAgent(user(), A2);
  expect(resolved.find((skill) => skill.name === "team")?.version).toBe(2);
});

test("a workspace with no library skills still gets its marker", async () => {
  const { service, db } = setup();

  const result = await service.migrateLibrary(user());

  expect(result).toEqual({ migrated: 0, skipped: [] });
  expect(db.select().from(skillLibraryMigrations).all()).toHaveLength(1);
});

test("migration events name the system and carry no file contents", async () => {
  await env.service.migrateLibrary(user());

  const created = env.db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "skill.created"))
    .all();

  expect(created).toHaveLength(5);
  for (const event of created) {
    expect(event).toMatchObject({ actorId: "migration", actorKind: "system" });
    const payload = JSON.parse(event.payload ?? "{}");
    expect(payload).toMatchObject({
      migrated: true,
      status: "approved",
      version: 1,
    });
    expect(event.payload).not.toContain("echo own");
    expect(event.payload).not.toContain("Do the thing");
  }
});

test("a library skill over the file cap is skipped with a reason and the rest still migrate", async () => {
  await Promise.all(
    Array.from({ length: 201 }, (_, index) =>
      put(`skills/a2/huge/f${index}.txt`, "x")
    )
  );
  await put("skills/a2/huge/SKILL.md", skillMd("huge"));

  const result = await env.service.migrateLibrary(user());

  expect(result.migrated).toBe(5);
  expect(
    result.skipped.find((entry) => entry.path === "skills/a2/huge")?.reason
  ).toContain("200 files");
});

test("two first accesses at once migrate once and neither fails", async () => {
  const results = await Promise.all([
    env.service.list(user()),
    env.service.forAgent(run(A1), A1),
    env.service.list(user()),
  ]);

  expect(results[0]).toHaveLength(5);
  expect(results[1].map((skill) => skill.name)).toEqual([
    "dup",
    "own-skill",
    "team",
  ]);
  expect(counts()).toMatchObject({ markers: 1, skills: 5, versions: 5 });
});
