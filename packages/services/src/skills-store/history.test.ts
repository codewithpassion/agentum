import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { skillVersions } from "@repo/db/schema/skills";
import { eq } from "drizzle-orm";
import { ForbiddenError } from "../authz.ts";
import { isServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import type { FileRecord, FileWrite } from "./records.ts";
import {
  A1,
  bytes,
  createSkill,
  decode,
  errorOf,
  R1,
  readOnlyUser,
  run,
  setup,
  skillMd,
  user,
  W2,
} from "./test-support.ts";

type Env = ReturnType<typeof setup>;
type Service = Env["service"];

const BLOB_PREFIX = "skill-blobs/";
const BLOB_KEY = /^skill-blobs\/[0-9a-f]{64}$/;
const MB = 1024 * 1024;

let env: Env;
beforeEach(() => {
  env = setup();
});

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const keyFor = (value: string): string =>
  `${BLOB_PREFIX}${sha256(bytes(value))}`;

const textOf = (file: FileRecord): string | null =>
  file.content === undefined ? null : decode(file.content);

/** The error code of a call: "ok" when it resolves, the code of a service error, "forbidden" for ForbiddenError. */
const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await errorOf(promise);
  if (error === null) {
    return "ok";
  }
  if (error instanceof ForbiddenError) {
    return "forbidden";
  }
  if (isServiceError(error)) {
    return error.code;
  }
  return `unexpected: ${String(error)}`;
};

const commitOn = (
  service: Service,
  skillId: string,
  baseVersion: number,
  options: {
    deletes?: string[];
    message?: string;
    principal?: Principal;
    writes?: FileWrite[];
  } = {}
) =>
  service.commit(options.principal ?? user(), {
    baseVersion,
    deletes: (options.deletes ?? []).map((path) => ({ path })),
    message: options.message ?? "Change",
    skillId,
    writes: options.writes ?? [],
  });

/** A new skill whose SKILL.md names `frontmatter` while the skill is called `name`. */
const createSkillAs = (service: Service, name: string, frontmatter: string) =>
  service.create(user(), {
    files: [{ content: skillMd(frontmatter), path: "SKILL.md" }],
    message: "First",
    name,
  });

const pathsOf = async (service: Service, skillId: string, version: number) =>
  (await service.show(user(), { skillId, version })).files.map(
    (file) => file.path
  );

const versionNumbersOf = async (db: Env["db"], skillId: string) =>
  (
    await db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
  ).map((row) => row.number);

describe("create", () => {
  test("a person's valid skill is approved version 1 with its files", async () => {
    const { service } = env;
    const { skill, version } = await service.create(user(), {
      files: [
        { content: skillMd("alpha"), path: "SKILL.md" },
        { content: "hi", path: "notes/a.txt" },
      ],
      message: "First",
      name: "alpha",
    });
    expect(version.number).toBe(1);
    expect(version.status).toBe("approved");
    expect(version.parent).toBeNull();
    expect(version.author).toEqual({ id: "u1", kind: "user", runId: null });
    expect(skill.ownerAgentId).toBeNull();
    expect(skill.latestApprovedVersion).toBe(1);
    const shown = await service.show(user(), {
      skillId: skill.id,
      version: 1,
      withContents: true,
    });
    expect(shown.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "notes/a.txt",
    ]);
    expect(shown.files.map(textOf)).toEqual([skillMd("alpha"), "hi"]);
  });

  test("names that break the naming rule are invalid", async () => {
    const { service } = env;
    const names = ["Bad Name", "a--b", "a".repeat(65)];
    const codes = await Promise.all(
      names.map((name) => codeOf(createSkill(service, name)))
    );
    expect(codes).toEqual(["invalid", "invalid", "invalid"]);
  });

  test("a tree without SKILL.md is invalid", async () => {
    const { service } = env;
    const code = await codeOf(
      service.create(user(), {
        files: [{ content: "x", path: "README.md" }],
        message: "First",
        name: "alpha",
      })
    );
    expect(code).toBe("invalid");
  });

  test("a SKILL.md whose frontmatter name differs from the skill name is invalid", async () => {
    const { service } = env;
    const code = await codeOf(createSkillAs(service, "beta", "alpha"));
    expect(code).toBe("invalid");
  });

  test("a SKILL.md that is not UTF-8 is invalid", async () => {
    const { service } = env;
    const code = await codeOf(
      service.create(user(), {
        files: [{ content: new Uint8Array([0xff, 0xfe]), path: "SKILL.md" }],
        message: "First",
        name: "alpha",
      })
    );
    expect(code).toBe("invalid");
  });

  test("the same name twice by a person is a conflict", async () => {
    const { service } = env;
    expect(await codeOf(createSkill(service, "alpha"))).toBe("ok");
    expect(await codeOf(createSkill(service, "alpha"))).toBe("conflict");
  });

  test("the same name by a person and by a run, owned by different owners, both work", async () => {
    const { service } = env;
    const person = await createSkill(service, "alpha");
    const agent = await createSkill(service, "alpha", {}, run());
    expect(person.skill.ownerAgentId).toBeNull();
    expect(person.version.status).toBe("approved");
    expect(agent.skill.ownerAgentId).toBe(A1);
    expect(agent.skill.id).not.toBe(person.skill.id);
    expect(agent.version.status).toBe("proposed");
  });

  test("a name taken in workspace W1 is free in workspace W2", async () => {
    const { service } = env;
    expect(await codeOf(createSkill(service, "alpha"))).toBe("ok");
    const other = await createSkill(service, "alpha", {}, user(W2));
    expect(other.skill.ownerAgentId).toBeNull();
    expect(other.version.number).toBe(1);
  });
});

describe("multi-file commit", () => {
  test("new files, a delete and a changed SKILL.md make version 2 with exactly the expected tree", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha", {
      "gone.txt": "bye",
      "keep.txt": "keep",
    });
    const commit = await commitOn(service, skill.id, 1, {
      deletes: ["gone.txt"],
      message: "Multi",
      writes: [
        { content: skillMd("alpha", "Changed."), path: "SKILL.md" },
        { content: "1", path: "new/one.txt" },
        { content: "2", path: "new/two.txt" },
        { content: "3", path: "new/three.txt" },
      ],
    });
    expect(commit.number).toBe(2);
    expect(commit.parent).toBe(1);
    expect(commit.status).toBe("approved");
    expect(commit.message).toBe("Multi");
    expect(await pathsOf(service, skill.id, 2)).toEqual([
      "SKILL.md",
      "keep.txt",
      "new/one.txt",
      "new/three.txt",
      "new/two.txt",
    ]);
  });

  test("a later commit that rewrites a file without the flag keeps its executable flag", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    await commitOn(service, skill.id, 1, {
      writes: [{ content: "echo a", executable: true, path: "tool.sh" }],
    });
    await commitOn(service, skill.id, 2, {
      writes: [{ content: "echo b", path: "tool.sh" }],
    });
    const third = await service.show(user(), { skillId: skill.id, version: 3 });
    expect(third.version.parent).toBe(2);
    const tool = third.files.find((file) => file.path === "tool.sh");
    expect(tool?.executable).toBe(true);
    expect(tool?.hash).toBe(sha256(bytes("echo b")));
  });
});

describe("stale base", () => {
  test("committing on version 1 after version 2 exists is a conflict", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    await commitOn(service, skill.id, 1, {
      writes: [{ content: "a", path: "a.txt" }],
    });
    const code = await codeOf(
      commitOn(service, skill.id, 1, {
        writes: [{ content: "b", path: "a.txt" }],
      })
    );
    expect(code).toBe("conflict");
  });

  test("committing on a base version that does not exist is a conflict", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    const code = await codeOf(
      commitOn(service, skill.id, 99, {
        writes: [{ content: "a", path: "a.txt" }],
      })
    );
    expect(code).toBe("conflict");
  });

  test("two commits racing on the same base: one wins, the other is a conflict, one new version is stored", async () => {
    const { db, service } = env;
    const { skill } = await createSkill(service, "alpha");
    const results = await Promise.allSettled([
      commitOn(service, skill.id, 1, {
        writes: [{ content: "A", path: "a.txt" }],
      }),
      commitOn(service, skill.id, 1, {
        writes: [{ content: "B", path: "b.txt" }],
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const codes = results.flatMap((r) =>
      r.status === "rejected" && isServiceError(r.reason) ? [r.reason.code] : []
    );
    expect(fulfilled).toHaveLength(1);
    expect(codes).toEqual(["conflict"]);
    expect(await versionNumbersOf(db, skill.id)).toEqual([1, 2]);
  });
});

describe("commit validation", () => {
  test.each(["../x", "/abs", "a\\b", "a//b", "./a"])(
    "the unsafe path %s is invalid and writes nothing",
    async (path) => {
      const { blobs, db, service } = env;
      const { skill } = await createSkill(service, "alpha");
      const putsBefore = blobs.puts.length;
      const code = await codeOf(
        commitOn(service, skill.id, 1, { writes: [{ content: "x", path }] })
      );
      expect(code).toBe("invalid");
      expect(await versionNumbersOf(db, skill.id)).toEqual([1]);
      expect(blobs.puts).toHaveLength(putsBefore);
    }
  );

  test("deleting a path that is not in the tree is invalid", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    const code = await codeOf(
      commitOn(service, skill.id, 1, { deletes: ["nope.txt"] })
    );
    expect(code).toBe("invalid");
  });

  test("deleting SKILL.md is invalid", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha", { "x.txt": "x" });
    const code = await codeOf(
      commitOn(service, skill.id, 1, { deletes: ["SKILL.md"] })
    );
    expect(code).toBe("invalid");
  });

  test("writing and deleting the same path is invalid", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha", { "x.txt": "old" });
    const code = await codeOf(
      commitOn(service, skill.id, 1, {
        deletes: ["x.txt"],
        writes: [{ content: "new", path: "x.txt" }],
      })
    );
    expect(code).toBe("invalid");
  });

  test("a commit that changes nothing is invalid", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha", { "x.txt": "old" });
    const code = await codeOf(
      commitOn(service, skill.id, 1, {
        writes: [{ content: "old", path: "x.txt" }],
      })
    );
    expect(code).toBe("invalid");
  });

  test("a tree of more than 200 files is invalid", async () => {
    const { service } = env;
    const extra = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [`f/${i}.txt`, `${i}`])
    );
    const { skill } = await createSkill(service, "alpha", extra);
    const writes = Array.from({ length: 60 }, (_, i) => ({
      content: `new ${i}`,
      path: `g/${i}.txt`,
    }));
    const code = await codeOf(commitOn(service, skill.id, 1, { writes }));
    expect(code).toBe("invalid");
  });

  test("two files that together pass 5 MB are invalid", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    const big = "x".repeat(Math.round(2.6 * MB));
    const code = await codeOf(
      commitOn(service, skill.id, 1, {
        writes: [
          { content: big, path: "big/a.txt" },
          { content: big, path: "big/b.txt" },
        ],
      })
    );
    expect(code).toBe("invalid");
  });

  test("a file that is also a folder of another file is invalid", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    const code = await codeOf(
      commitOn(service, skill.id, 1, {
        writes: [
          { content: "file", path: "a" },
          { content: "inside", path: "a/b" },
        ],
      })
    );
    expect(code).toBe("invalid");
  });
});

describe("log and show", () => {
  test("log lists versions newest first with message, author and status", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    await commitOn(service, skill.id, 1, {
      message: "Second",
      writes: [{ content: "a", path: "a.txt" }],
    });
    await commitOn(service, skill.id, 2, {
      message: "Third",
      writes: [{ content: "b", path: "b.txt" }],
    });
    const log = await service.log(user(), { skillId: skill.id });
    expect(log.map((v) => v.number)).toEqual([3, 2, 1]);
    expect(log.map((v) => v.message)).toEqual([
      "Third",
      "Second",
      "First version",
    ]);
    expect(log.map((v) => v.status)).toEqual([
      "approved",
      "approved",
      "approved",
    ]);
    expect(log[0]?.author).toEqual({ id: "u1", kind: "user", runId: null });
  });

  test("show lists the tree sorted by path with hash, size and flag, and contents only on request", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha", {
      "a/y.txt": "why",
      "B.txt": "bee",
      "z.txt": "zed",
    });
    const shown = await service.show(user(), { skillId: skill.id, version: 1 });
    expect(shown.version.number).toBe(1);
    expect(shown.files.map((file) => file.path)).toEqual([
      "B.txt",
      "SKILL.md",
      "a/y.txt",
      "z.txt",
    ]);
    const zed = shown.files.find((file) => file.path === "z.txt");
    expect(zed).toEqual({
      executable: false,
      hash: sha256(bytes("zed")),
      path: "z.txt",
      size: 3,
    });
    expect(shown.files.some((file) => "content" in file)).toBe(false);
    const withBytes = await service.show(user(), {
      skillId: skill.id,
      version: 1,
      withContents: true,
    });
    expect(withBytes.files.map(textOf)).toEqual([
      "bee",
      skillMd("alpha"),
      "why",
      "zed",
    ]);
  });

  test("show of a version number that does not exist is not_found", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    const code = await codeOf(
      service.show(user(), { skillId: skill.id, version: 7 })
    );
    expect(code).toBe("not_found");
  });
});

describe("diff", () => {
  test("added, removed and changed paths between two versions, with a patch for changed text", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha", {
      "bin.dat": "x",
      "change.txt": "one\n",
      "flip.sh": "run",
      "gone.txt": "bye\n",
    });
    await commitOn(service, skill.id, 1, {
      deletes: ["gone.txt"],
      writes: [
        { content: new Uint8Array([0x00, 0x01, 0x02]), path: "bin.dat" },
        { content: "two\n", path: "change.txt" },
        { content: "fresh\n", path: "new.txt" },
        { content: "run", executable: true, path: "flip.sh" },
      ],
    });
    const result = await service.diff(user(), {
      from: 1,
      skillId: skill.id,
      to: 2,
    });
    expect(result.added).toEqual(["new.txt"]);
    expect(result.removed).toEqual(["gone.txt"]);
    expect(result.changed).toEqual(["bin.dat", "change.txt", "flip.sh"]);
    expect(result.patches.map((entry) => entry.path)).toEqual([
      "change.txt",
      "gone.txt",
      "new.txt",
    ]);
    const change = result.patches.find((e) => e.path === "change.txt");
    expect(change?.patch).toContain("\n-one\n");
    expect(change?.patch).toContain("\n+two\n");
  });

  test("a changed binary file is listed as changed with no patch", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha", { "bin.dat": "x" });
    await commitOn(service, skill.id, 1, {
      writes: [{ content: new Uint8Array([0x00, 0x09]), path: "bin.dat" }],
    });
    const result = await service.diff(user(), {
      from: 1,
      skillId: skill.id,
      to: 2,
    });
    expect(result.changed).toEqual(["bin.dat"]);
    expect(result.patches.map((entry) => entry.path)).not.toContain("bin.dat");
  });

  test("a pure executable-flag change is listed as changed", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    await commitOn(service, skill.id, 1, {
      writes: [{ content: "run", executable: true, path: "flip.sh" }],
    });
    await commitOn(service, skill.id, 2, {
      writes: [{ content: "run", executable: false, path: "flip.sh" }],
    });
    const result = await service.diff(user(), {
      from: 2,
      skillId: skill.id,
      to: 3,
    });
    expect(result.added).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.changed).toEqual(["flip.sh"]);
  });
});

describe("revert", () => {
  test("reverting to version 1 makes version 4 with version 1's tree and the default message", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha", { "a.txt": "A" });
    await commitOn(service, skill.id, 1, {
      writes: [{ content: "B", path: "a.txt" }],
    });
    await commitOn(service, skill.id, 2, {
      writes: [
        { content: "C", path: "a.txt" },
        { content: "D", path: "b.txt" },
      ],
    });
    const reverted = await service.revert(user(), {
      skillId: skill.id,
      toVersion: 1,
    });
    expect(reverted.number).toBe(4);
    expect(reverted.parent).toBe(3);
    expect(reverted.message).toBe("Revert to version 1");
    const first = await service.show(user(), { skillId: skill.id, version: 1 });
    const fourth = await service.show(user(), {
      skillId: skill.id,
      version: 4,
    });
    expect(fourth.files.map((f) => [f.path, f.hash])).toEqual(
      first.files.map((f) => [f.path, f.hash])
    );
  });

  test("reverting to the current tree is invalid", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha", { "a.txt": "A" });
    await commitOn(service, skill.id, 1, {
      writes: [{ content: "B", path: "a.txt" }],
    });
    const code = await codeOf(
      service.revert(user(), { skillId: skill.id, toVersion: 2 })
    );
    expect(code).toBe("invalid");
  });

  test("reverting to a rejected version is invalid", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha", {}, run(A1, R1));
    await commitOn(service, skill.id, 1, {
      principal: run(A1, R1),
      writes: [{ content: "proposed", path: "p.txt" }],
    });
    await service.reject(user(), { skillId: skill.id, version: 2 });
    const code = await codeOf(
      service.revert(user(), { skillId: skill.id, toVersion: 2 })
    );
    expect(code).toBe("invalid");
  });
});

describe("blob storage", () => {
  test("a file whose bytes do not change in a commit is not put again", async () => {
    const { blobs, service } = env;
    const { skill } = await createSkill(service, "alpha", {
      "keep.txt": "same bytes",
    });
    await commitOn(service, skill.id, 1, {
      writes: [
        { content: skillMd("alpha", "Changed."), path: "SKILL.md" },
        { content: "same bytes", path: "keep.txt" },
      ],
    });
    const keyPuts = blobs.puts.filter((key) => key === keyFor("same bytes"));
    expect(keyPuts).toHaveLength(1);
    expect(blobs.puts).toHaveLength(3);
    expect(new Set(blobs.puts).size).toBe(blobs.puts.length);
  });

  test("the same bytes in two skills are put under one key", async () => {
    const { blobs, service } = env;
    await createSkill(service, "alpha", { "keep.txt": "same bytes" });
    await createSkill(service, "beta", { "keep.txt": "same bytes" });
    const keyPuts = blobs.puts.filter((key) => key === keyFor("same bytes"));
    expect(keyPuts).toHaveLength(1);
  });

  test("blob keys are skill-blobs/ plus 64 hex characters, and each object hashes to its key", async () => {
    const { blobs, service } = env;
    await createSkill(service, "alpha", { "keep.txt": "same bytes" });
    expect(blobs.puts.every((key) => BLOB_KEY.test(key))).toBe(true);
    expect(blobs.objects.size).toBe(2);
    for (const [key, object] of blobs.objects) {
      expect(sha256(object)).toBe(key.slice(BLOB_PREFIX.length));
    }
  });
});

describe("access", () => {
  test("a person in workspace W2 gets not_found for show, log and commit on a W1 skill", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    const outsider = user(W2);
    const show = codeOf(
      service.show(outsider, { skillId: skill.id, version: 1 })
    );
    const log = codeOf(service.log(outsider, { skillId: skill.id }));
    const commit = codeOf(
      commitOn(service, skill.id, 1, {
        principal: outsider,
        writes: [{ content: "a", path: "a.txt" }],
      })
    );
    expect(await show).toBe("not_found");
    expect(await log).toBe("not_found");
    expect(await commit).toBe("not_found");
  });

  test("a read-only API key gets ForbiddenError for create and commit, and can list and show", async () => {
    const { service } = env;
    const { skill } = await createSkill(service, "alpha");
    const create = codeOf(createSkill(service, "beta", {}, readOnlyUser()));
    const commit = codeOf(
      commitOn(service, skill.id, 1, {
        principal: readOnlyUser(),
        writes: [{ content: "a", path: "a.txt" }],
      })
    );
    expect(await create).toBe("forbidden");
    expect(await commit).toBe("forbidden");
    const listed = await service.list(readOnlyUser());
    expect(listed.map((entry) => entry.name)).toEqual(["alpha"]);
    const shown = await service.show(readOnlyUser(), {
      skillId: skill.id,
      version: 1,
    });
    expect(shown.files.map((file) => file.path)).toEqual(["SKILL.md"]);
  });
});
