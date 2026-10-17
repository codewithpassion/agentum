import { expect, test } from "bun:test";
import { events as eventRows } from "@repo/db/schema/events";
import { skills, skillVersions } from "@repo/db/schema/skills";
import { eq } from "drizzle-orm";
import { unzipSync, type Zippable, zipSync } from "fflate";
import { ForbiddenError } from "../authz.ts";
import { isServiceError } from "../errors.ts";
import { type ArchiveFile, packArchive } from "./archive.ts";
import type { FileRecord } from "./records.ts";
import {
  A1,
  A2,
  bytes,
  errorOf,
  R1,
  R2,
  readOnlyUser,
  run,
  setup,
  skillMd,
  user,
  W2,
} from "./test-support.ts";

const MB = 1024 * 1024;
const MTIME = new Date("2026-10-01T00:00:00Z");
const MARKER = "UNIQUE-BODY-MARKER";
const SKILL_V1 = skillMd("shout", `Shout loudly. ${MARKER}`);
const SKILL_V2 = skillMd("shout", "Shout quietly.");

/** The first version of the `shout` skill: four files, one of them executable and one binary. */
const v1Files = (): ArchiveFile[] => [
  { bytes: bytes(SKILL_V1), executable: false, path: "SKILL.md" },
  {
    bytes: bytes("#!/bin/sh\necho HELLO\n"),
    executable: true,
    path: "scripts/run.sh",
  },
  {
    bytes: bytes("Notes on shouting.\n"),
    executable: false,
    path: "references/notes.md",
  },
  {
    bytes: new Uint8Array([0, 255, 16, 0, 128, 7]),
    executable: false,
    path: "assets/pixel.bin",
  },
];

/** The second version: SKILL.md changed, notes.md removed, docs/new.md added. */
const v2Files = (): ArchiveFile[] => [
  { bytes: bytes(SKILL_V2), executable: false, path: "SKILL.md" },
  {
    bytes: bytes("#!/bin/sh\necho HELLO\n"),
    executable: true,
    path: "scripts/run.sh",
  },
  { bytes: bytes("A new doc.\n"), executable: false, path: "docs/new.md" },
  {
    bytes: new Uint8Array([0, 255, 16, 0, 128, 7]),
    executable: false,
    path: "assets/pixel.bin",
  },
];

const archiveOf = (files: ArchiveFile[]): Uint8Array =>
  packArchive("shout", files, MTIME);

const zipOf = (entries: Record<string, string | Uint8Array>): Uint8Array => {
  const zippable: Zippable = {};
  for (const [path, value] of Object.entries(entries)) {
    zippable[path] = typeof value === "string" ? bytes(value) : value;
  }
  return zipSync(zippable);
};

const randomBytes = (length: number): Uint8Array => {
  const out = new Uint8Array(length);
  const chunk = 65_536;
  for (let at = 0; at < length; at += chunk) {
    const part = new Uint8Array(Math.min(chunk, length - at));
    crypto.getRandomValues(part);
    out.set(part, at);
  }
  return out;
};

const sortByPath = <T extends { path: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => (a.path < b.path ? -1 : 1));

/** The contents of a fixture tree, sorted by path. */
const fixtureTree = (files: readonly ArchiveFile[]) =>
  sortByPath(files).map((file) => ({
    content: file.bytes,
    executable: file.executable,
    path: file.path,
  }));

const contentTree = (files: readonly FileRecord[]) =>
  sortByPath(files).map((file) => ({
    content: file.content,
    executable: file.executable,
    path: file.path,
  }));

const shapeTree = (files: readonly FileRecord[]) =>
  sortByPath(files).map((file) => ({
    executable: file.executable,
    hash: file.hash,
    path: file.path,
    size: file.size,
  }));

/** The error code of a rejected call, "forbidden" for ForbiddenError, "none" when it resolves. */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  const caught = await errorOf(promise);
  if (caught instanceof ForbiddenError) {
    return caught.code;
  }
  if (isServiceError(caught)) {
    return caught.code;
  }
  return "none";
};

const payloadOf = (payload: string | null): Record<string, unknown> =>
  JSON.parse(payload ?? "{}") as Record<string, unknown>;

test("importing a valid archive by a person creates an approved version 1 with every file", async () => {
  const { service } = setup();
  const result = await service.importSkillArchive(user(), archiveOf(v1Files()));
  expect(result.created).toBe(true);
  expect(result.name).toBe("shout");
  expect(result.version.number).toBe(1);
  expect(result.version.status).toBe("approved");

  const shown = await service.show(user(), {
    skillId: result.version.skillId,
    version: 1,
    withContents: true,
  });
  expect(shown.version.status).toBe("approved");
  expect(contentTree(shown.files)).toEqual(fixtureTree(v1Files()));
  expect(
    sortByPath(shown.files)
      .filter((file) => file.executable)
      .map((file) => file.path)
  ).toEqual(["scripts/run.sh"]);
});

test("an exported skill imported into another workspace makes an identical tree", async () => {
  const { service } = setup();
  const source = await service.importSkillArchive(user(), archiveOf(v1Files()));
  const exported = await service.exportSkillArchive(user(), {
    skillId: source.version.skillId,
    version: 1,
  });
  expect(exported.filename).toBe("shout.skill");

  const unzipped = unzipSync(exported.bytes);
  expect(Object.keys(unzipped).sort()).toEqual([
    "shout/SKILL.md",
    "shout/assets/pixel.bin",
    "shout/references/notes.md",
    "shout/scripts/run.sh",
  ]);
  for (const file of v1Files()) {
    expect(Array.from(unzipped[`shout/${file.path}`] ?? [])).toEqual(
      Array.from(file.bytes)
    );
  }

  const copy = await service.importSkillArchive(user(W2), exported.bytes);
  expect(copy.created).toBe(true);
  expect(copy.name).toBe("shout");
  const original = await service.show(user(), {
    skillId: source.version.skillId,
    version: 1,
    withContents: true,
  });
  const imported = await service.show(user(W2), {
    skillId: copy.version.skillId,
    version: 1,
    withContents: true,
  });
  expect(shapeTree(imported.files)).toEqual(shapeTree(original.files));
  expect(contentTree(imported.files)).toEqual(contentTree(original.files));
});

test("importing a changed archive under the same name adds version 2 holding exactly the new tree", async () => {
  const { blobs, service } = setup();
  const first = await service.importSkillArchive(user(), archiveOf(v1Files()));
  const { skillId } = first.version;

  const second = await service.importSkillArchive(user(), archiveOf(v2Files()));
  expect(second.created).toBe(false);
  expect(second.version.number).toBe(2);
  expect(second.version.parent).toBe(1);
  expect(second.version.skillId).toBe(skillId);

  const shown = await service.show(user(), {
    skillId,
    version: 2,
    withContents: true,
  });
  expect(contentTree(shown.files)).toEqual(fixtureTree(v2Files()));

  expect(
    await codeOf(service.importSkillArchive(user(), archiveOf(v2Files())))
  ).toBe("invalid");
  const log = await service.log(user(), { skillId });
  expect(log.map((version) => version.number)).toEqual([2, 1]);

  expect(new Set(blobs.puts).size).toBe(blobs.puts.length);
  expect(blobs.puts.length).toBe(6);
});

test("a run's import creates a proposed skill owned by its agent, and a second import adds a proposed version", async () => {
  const { db, service } = setup();
  const first = await service.importSkillArchive(
    run(A1, R1),
    archiveOf(v1Files())
  );
  expect(first.created).toBe(true);
  expect(first.version.number).toBe(1);
  expect(first.version.status).toBe("proposed");

  const [row] = db.select().from(skills).where(eq(skills.name, "shout")).all();
  expect(row?.ownerAgentId).toBe(A1);
  expect(row?.id).toBe(first.version.skillId);

  const second = await service.importSkillArchive(
    run(A1, R1),
    archiveOf(v2Files())
  );
  expect(second.created).toBe(false);
  expect(second.version.skillId).toBe(first.version.skillId);
  expect(second.version.number).toBe(2);
  expect(second.version.parent).toBe(1);
  expect(second.version.status).toBe("proposed");

  const own = await service.show(run(A1, R1), {
    skillId: first.version.skillId,
    version: 2,
    withContents: true,
  });
  expect(contentTree(own.files)).toEqual(fixtureTree(v2Files()));
});

test("a run's import of a name a person owns makes a separate skill in the agent's scope", async () => {
  const { db, service } = setup();
  const person = await service.importSkillArchive(user(), archiveOf(v1Files()));
  const agent = await service.importSkillArchive(
    run(A1, R1),
    archiveOf(v1Files())
  );
  expect(agent.created).toBe(true);
  expect(agent.version.number).toBe(1);
  expect(agent.version.status).toBe("proposed");
  expect(agent.version.skillId).not.toBe(person.version.skillId);

  const rows = db.select().from(skills).where(eq(skills.name, "shout")).all();
  expect(rows.map((row) => row.id).sort()).toEqual(
    [person.version.skillId, agent.version.skillId].sort()
  );
  expect(
    rows.find((row) => row.id === person.version.skillId)?.ownerAgentId
  ).toBeNull();
  expect(
    rows.find((row) => row.id === agent.version.skillId)?.ownerAgentId
  ).toBe(A1);

  const personVersions = db
    .select()
    .from(skillVersions)
    .where(eq(skillVersions.skillId, person.version.skillId))
    .all();
  expect(personVersions.map((version) => version.status)).toEqual(["approved"]);
});

const refusals: [string, () => Uint8Array][] = [
  [
    "a ../ entry inside the folder",
    () => zipOf({ "shout/../evil.txt": "x", "shout/SKILL.md": SKILL_V1 }),
  ],
  ["an absolute path entry", () => zipOf({ "/shout/SKILL.md": SKILL_V1 })],
  [
    "a backslash in a name",
    () => zipOf({ "shout/ref\\notes.md": "x", "shout/SKILL.md": SKILL_V1 }),
  ],
  [
    "two top-level folders",
    () => zipOf({ "other/notes.md": "x", "shout/SKILL.md": SKILL_V1 }),
  ],
  ["files at the zip root only", () => zipOf({ "SKILL.md": SKILL_V1 })],
  ["no SKILL.md", () => zipOf({ "shout/notes.md": "x" })],
  [
    "a frontmatter name different from the folder name",
    () => zipOf({ "shout/SKILL.md": skillMd("other") }),
  ],
  [
    "a folder name that is not a valid skill name",
    () => zipOf({ "Bad Name/SKILL.md": skillMd("Bad Name") }),
  ],
  [
    "a SKILL.md that is not UTF-8",
    () =>
      zipOf({
        "shout/SKILL.md": new Uint8Array([0xff, 0xfe, 0xfd, 0x00]),
      }),
  ],
  ["random bytes that are not a zip", () => randomBytes(512)],
  [
    "more than 200 files",
    () => {
      const entries: Record<string, string> = { "shout/SKILL.md": SKILL_V1 };
      for (let index = 0; index < 200; index += 1) {
        entries[`shout/f${index}.txt`] = "x";
      }
      return zipOf(entries);
    },
  ],
  [
    "a zip bomb of 6 MB of zeros in one deflated entry",
    () =>
      zipOf({
        "shout/big.bin": new Uint8Array(6 * MB),
        "shout/SKILL.md": SKILL_V1,
      }),
  ],
  [
    "more than 10 MB of stored data",
    () =>
      zipSync({
        "shout/noise.bin": [randomBytes(10 * MB + 1024), { level: 0 }],
        "shout/SKILL.md": bytes(SKILL_V1),
      }),
  ],
];

test.each(refusals)(
  "refuses an archive with %s as invalid and adds no skill rows",
  async (_label, build) => {
    const { db, service } = setup();
    expect(await codeOf(service.importSkillArchive(user(), build()))).toBe(
      "invalid"
    );
    expect(db.select().from(skills).all()).toEqual([]);
    expect(db.select().from(skillVersions).all()).toEqual([]);
  }
);

test("macOS junk files in the archive are ignored on import", async () => {
  const { service } = setup();
  const zip = zipOf({
    "__MACOSX/shout/._SKILL.md": "junk",
    "shout/.DS_Store": "junk",
    "shout/notes.md": "Notes.\n",
    "shout/SKILL.md": skillMd("shout", "Shout loudly."),
  });
  const result = await service.importSkillArchive(user(), zip);
  expect(result.created).toBe(true);
  const shown = await service.show(user(), {
    skillId: result.version.skillId,
    version: 1,
    withContents: true,
  });
  expect(sortByPath(shown.files).map((file) => file.path)).toEqual([
    "SKILL.md",
    "notes.md",
  ]);
});

test("a read-only API key may export but not import", async () => {
  const { service } = setup();
  const source = await service.importSkillArchive(user(), archiveOf(v1Files()));
  expect(
    await codeOf(
      service.importSkillArchive(readOnlyUser(), archiveOf(v1Files()))
    )
  ).toBe("forbidden");
  const exported = await service.exportSkillArchive(readOnlyUser(), {
    skillId: source.version.skillId,
    version: 1,
  });
  expect(exported.filename).toBe("shout.skill");
});

test("a person of another workspace cannot export a skill and gets not_found", async () => {
  const { service } = setup();
  const source = await service.importSkillArchive(user(), archiveOf(v1Files()));
  expect(
    await codeOf(
      service.exportSkillArchive(user(W2), {
        skillId: source.version.skillId,
        version: 1,
      })
    )
  ).toBe("not_found");
});

test("a run cannot export another agent's proposed skill, and its own run can", async () => {
  const { service } = setup();
  const proposed = await service.importSkillArchive(
    run(A1, R1),
    archiveOf(v1Files())
  );
  expect(
    await codeOf(
      service.exportSkillArchive(run(A2, R2), {
        skillId: proposed.version.skillId,
        version: 1,
      })
    )
  ).toBe("not_found");
  const exported = await service.exportSkillArchive(run(A1, R1), {
    skillId: proposed.version.skillId,
    version: 1,
  });
  expect(exported.filename).toBe("shout.skill");
});

test("an import writes one skill.imported event per import, with the outcome and no file contents", async () => {
  const { db, service } = setup();
  const first = await service.importSkillArchive(user(), archiveOf(v1Files()));
  const second = await service.importSkillArchive(user(), archiveOf(v2Files()));

  const rows = db
    .select()
    .from(eventRows)
    .where(eq(eventRows.type, "skill.imported"))
    .all();
  expect(rows.length).toBe(2);

  const byVersion = (version: number) =>
    rows.filter((row) => payloadOf(row.payload).version === version);
  const [firstRow] = byVersion(1);
  const [secondRow] = byVersion(2);
  expect(byVersion(1).length).toBe(1);
  expect(byVersion(2).length).toBe(1);
  expect(payloadOf(firstRow?.payload ?? null)).toEqual({
    created: true,
    name: "shout",
    skillId: first.version.skillId,
    status: "approved",
    version: 1,
  });
  expect(payloadOf(secondRow?.payload ?? null)).toEqual({
    created: false,
    name: "shout",
    skillId: second.version.skillId,
    status: "approved",
    version: 2,
  });
  for (const row of rows) {
    expect(row.actorKind).toBe("user");
    expect(row.actorId).toBe("u1");
    expect(row.workspaceId).toBe("w1");
    expect(row.payload).not.toContain(MARKER);
    expect(row.payload).not.toContain("HELLO");
  }
});
