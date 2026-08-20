import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "#/db/client";
import type {
  PublishedSkill,
  SkillsGateway,
  SkillUpload,
} from "#/modules/anthropic/skills-gateway";
import {
  deleteSkillMirror,
  publishNewSkill,
  publishSkillVersion,
  retrySkillSync,
  type SkillPublishContext,
  unassignSkillEverywhere,
} from "./publish";
import {
  assignSkill,
  deleteSkillLocally,
  getSkillBySlug,
  listSkillFiles,
  listSkillVersions,
  readSkillFile,
  SkillCapError,
} from "./service";
import { MAX_AGENT_SKILLS } from "./validate";

/**
 * The publish pipeline against the shipped migrations in an in-memory database,
 * with R2 and the Anthropic skills API faked - the same combination
 * `modules/connectors` uses. No Anthropic client is ever constructed.
 */

const SLUG = "weekly-report";

const migrate = (): Db => {
  const dir = new URL("../../../drizzle/", import.meta.url);
  const journal = JSON.parse(
    readFileSync(new URL("meta/_journal.json", dir), "utf8")
  ) as { entries: { tag: string }[] };

  const sqlite = new Database(":memory:");
  for (const entry of journal.entries) {
    const sql = readFileSync(new URL(`${entry.tag}.sql`, dir), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      sqlite.run(statement);
    }
  }
  return drizzle(sqlite) as unknown as Db;
};

/** Just enough R2 for the module: put, get, delete - plus a log of every put. */
interface FakeBucket {
  bucket: R2Bucket;
  deleted: string[];
  objects: Map<string, string>;
  puts: string[];
}

const fakeBucket = (): FakeBucket => {
  const objects = new Map<string, string>();
  const puts: string[] = [];
  const deleted: string[] = [];
  const bucket = {
    delete(key: string) {
      deleted.push(key);
      objects.delete(key);
      return Promise.resolve();
    },
    get(key: string) {
      const value = objects.get(key);
      return Promise.resolve(
        value === undefined ? null : { text: () => Promise.resolve(value) }
      );
    },
    put(key: string, value: string) {
      puts.push(key);
      objects.set(key, value);
      return Promise.resolve({});
    },
  } as unknown as R2Bucket;
  return { bucket, deleted, objects, puts };
};

interface GatewayCalls {
  created: SkillUpload[];
  deletedSkills: string[];
  deletedVersions: string[];
  versions: { skillId: string; upload: SkillUpload }[];
}

const fakeGateway = (
  options: { failCreate?: boolean; failVersion?: boolean } = {}
): { calls: GatewayCalls; gateway: SkillsGateway } => {
  const calls: GatewayCalls = {
    created: [],
    deletedSkills: [],
    deletedVersions: [],
    versions: [],
  };
  let issued = 0;

  const gateway: SkillsGateway = {
    createSkill(upload): Promise<PublishedSkill> {
      calls.created.push(upload);
      if (options.failCreate) {
        return Promise.reject(new Error("anthropic is down"));
      }
      issued += 1;
      return Promise.resolve({
        anthropicSkillId: "skill_01",
        anthropicVersion: `v${issued}`,
      });
    },
    createVersion(skillId, upload) {
      calls.versions.push({ skillId, upload });
      if (options.failVersion) {
        return Promise.reject(new Error("anthropic is down"));
      }
      issued += 1;
      return Promise.resolve(`v${issued}`);
    },
    deleteSkill(skillId) {
      calls.deletedSkills.push(skillId);
      return Promise.resolve();
    },
    deleteVersion(_skillId, version) {
      calls.deletedVersions.push(version);
      return Promise.resolve();
    },
    listVersions() {
      return Promise.resolve(["v1", "v2"]);
    },
  };
  return { calls, gateway };
};

const skillMd = (body: string): string =>
  `---
name: ${SLUG}
description: Build the weekly report.
---

${body}
`;

const filesFor = (body: string, script: string) => [
  { content: skillMd(body), path: "SKILL.md" },
  { content: script, path: "scripts/run.ts" },
];

let db: Db;
let store: FakeBucket;

beforeEach(() => {
  db = migrate();
  store = fakeBucket();
});

const contextWith = (gateway: SkillsGateway | null): SkillPublishContext => ({
  bucket: store.bucket,
  db,
  gateway,
});

const createV1 = (ctx: SkillPublishContext, createdBy = "user") =>
  publishNewSkill(ctx, {
    changelog: "Created.",
    createdBy,
    files: filesFor("v1 body", "run v1\n"),
    slug: SLUG,
  });

describe("publishNewSkill", () => {
  test("writes the version locally and mirrors it", async () => {
    const { calls, gateway } = fakeGateway();
    const result = await createV1(contextWith(gateway));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.skill.syncStatus).toBe("synced");
    expect(result.skill.anthropicSkillId).toBe("skill_01");
    // The upload carries the directory layout, prefixed with the slug.
    expect(calls.created[0]?.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "scripts/run.ts",
    ]);
    expect(calls.created[0]?.slug).toBe(SLUG);

    const [version] = await listSkillVersions(db, result.skill.id);
    expect(version?.anthropicVersion).toBe("v1");
    expect(version?.version).toBe(1);
  });

  test("keeps the version usable when the mirror is off", async () => {
    const result = await createV1(contextWith(null));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    // No key configured is not a failure: it is a skill waiting for a retry.
    expect(result.skill.syncStatus).toBe("unsynced");
    expect(result.skill.syncError).toBeNull();

    const files = await listSkillFiles(db, result.version.id);
    expect(await readSkillFile(store.bucket, files[0] as never)).toContain(
      "v1 body"
    );
  });

  test("records a failed push without losing the version", async () => {
    const { gateway } = fakeGateway({ failCreate: true });
    const result = await createV1(contextWith(gateway));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.skill.syncStatus).toBe("error");
    expect(result.skill.syncError).toBe("anthropic is down");

    const stored = await getSkillBySlug(db, SLUG);
    expect(stored?.anthropicSkillId).toBeNull();
    expect((await listSkillVersions(db, result.skill.id)).length).toBe(1);
  });

  test("rejects an invalid skill before anything is written", async () => {
    const { calls, gateway } = fakeGateway();
    const result = await publishNewSkill(contextWith(gateway), {
      changelog: "",
      createdBy: "user",
      files: [{ content: "# no frontmatter\n", path: "SKILL.md" }],
      slug: SLUG,
    });

    expect(result.ok).toBe(false);
    expect(await getSkillBySlug(db, SLUG)).toBeUndefined();
    expect(calls.created.length).toBe(0);
    expect(store.puts.length).toBe(0);
  });
});

describe("publishSkillVersion", () => {
  test("never touches the previous version's rows or objects", async () => {
    const { gateway } = fakeGateway();
    const ctx = contextWith(gateway);
    const first = await createV1(ctx);
    if (!first.ok) {
      throw new Error("setup failed");
    }

    const before = await listSkillFiles(db, first.version.id);
    const beforeContents = await Promise.all(
      before.map((file) => readSkillFile(store.bucket, file))
    );

    const second = await publishSkillVersion(ctx, first.skill, {
      changelog: "fixed: script assumed bash",
      createdBy: "agent:a1",
      files: filesFor("v2 body", "run v2\n"),
    });
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }

    expect(second.version.version).toBe(2);
    expect(second.skill.latestVersion).toBe(2);
    expect(second.version.createdBy).toBe("agent:a1");

    const after = await listSkillFiles(db, first.version.id);
    expect(after).toEqual(before);
    expect(
      await Promise.all(after.map((file) => readSkillFile(store.bucket, file)))
    ).toEqual(beforeContents);
    // Copy-on-write: the new version wrote new keys rather than overwriting.
    const v2Files = await listSkillFiles(db, second.version.id);
    for (const file of v2Files) {
      expect(before.some((old) => old.r2Key === file.r2Key)).toBe(false);
    }
    expect(store.deleted).toEqual([]);
  });

  test("mirrors as a version of the existing skill", async () => {
    const { calls, gateway } = fakeGateway();
    const ctx = contextWith(gateway);
    const first = await createV1(ctx);
    if (!first.ok) {
      throw new Error("setup failed");
    }

    const second = await publishSkillVersion(ctx, first.skill, {
      changelog: "fix",
      createdBy: "user",
      files: filesFor("v2 body", "run v2\n"),
    });

    expect(calls.versions[0]?.skillId).toBe("skill_01");
    expect(calls.created.length).toBe(1);
    if (second.ok) {
      const versions = await listSkillVersions(db, second.skill.id);
      expect(versions.map((row) => row.anthropicVersion)).toEqual(["v2", "v1"]);
    }
  });
});

describe("retrySkillSync", () => {
  test("pushes every unmirrored version, oldest first", async () => {
    const offline = contextWith(null);
    const first = await createV1(offline);
    if (!first.ok) {
      throw new Error("setup failed");
    }
    const second = await publishSkillVersion(offline, first.skill, {
      changelog: "second",
      createdBy: "user",
      files: filesFor("v2 body", "run v2\n"),
    });
    if (!second.ok) {
      throw new Error("setup failed");
    }

    const { calls, gateway } = fakeGateway();
    const synced = await retrySkillSync(contextWith(gateway), second.skill);

    expect(synced.syncStatus).toBe("synced");
    // v1 creates the skill, v2 becomes its second version - so a pin to v1 has
    // a mirror id of its own rather than being permanently unattachable.
    expect(calls.created.length).toBe(1);
    expect(calls.versions.length).toBe(1);
    const versions = await listSkillVersions(db, second.skill.id);
    expect(versions.map((row) => row.anthropicVersion)).toEqual(["v2", "v1"]);
  });

  test("stops at the first failure and keeps the error", async () => {
    const first = await createV1(contextWith(null));
    if (!first.ok) {
      throw new Error("setup failed");
    }
    const { gateway } = fakeGateway({ failCreate: true });

    const synced = await retrySkillSync(contextWith(gateway), first.skill);

    expect(synced.syncStatus).toBe("error");
    expect((await getSkillBySlug(db, SLUG))?.syncStatus).toBe("error");
  });
});

describe("deletion", () => {
  test("drops every assignment and names the agents to resync", async () => {
    const first = await createV1(contextWith(null));
    if (!first.ok) {
      throw new Error("setup failed");
    }
    await assignSkill(db, { agentId: "agent-1", skillId: first.skill.id });
    await assignSkill(db, { agentId: "agent-2", skillId: first.skill.id });

    expect((await unassignSkillEverywhere(db, first.skill.id)).sort()).toEqual([
      "agent-1",
      "agent-2",
    ]);
  });

  test("deletes every version before the skill itself", async () => {
    const { calls, gateway } = fakeGateway();
    const first = await createV1(contextWith(gateway));
    if (!first.ok) {
      throw new Error("setup failed");
    }

    // The API refuses to delete a skill while any version exists.
    expect(
      await deleteSkillMirror(contextWith(gateway), first.skill)
    ).toBeNull();
    expect(calls.deletedVersions).toEqual(["v1", "v2"]);
    expect(calls.deletedSkills).toEqual(["skill_01"]);
  });

  test("reports a mirror failure rather than throwing", async () => {
    const first = await createV1(contextWith(null));
    if (!first.ok) {
      throw new Error("setup failed");
    }
    const gateway: SkillsGateway = {
      ...fakeGateway().gateway,
      listVersions: () => Promise.reject(new Error("gone")),
    };

    const error = await deleteSkillMirror(contextWith(gateway), {
      ...first.skill,
      anthropicSkillId: "skill_01",
    });

    expect(error).toBe("gone");
  });

  test("removes the local rows and the stored objects", async () => {
    const first = await createV1(contextWith(null));
    if (!first.ok) {
      throw new Error("setup failed");
    }

    await deleteSkillLocally(db, store.bucket, first.skill);

    expect(await getSkillBySlug(db, SLUG)).toBeUndefined();
    expect(store.objects.size).toBe(0);
    expect((await listSkillVersions(db, first.skill.id)).length).toBe(0);
  });
});

describe("assignSkill", () => {
  test("moves the pin instead of adding a second row", async () => {
    const first = await createV1(contextWith(null));
    if (!first.ok) {
      throw new Error("setup failed");
    }

    expect(
      await assignSkill(db, { agentId: "a1", skillId: first.skill.id })
    ).toBe("assigned");
    expect(
      await assignSkill(db, { agentId: "a1", skillId: first.skill.id })
    ).toBe("unchanged");
    // Re-assigning with a different pin is a real change, and must resync.
    expect(
      await assignSkill(db, {
        agentId: "a1",
        pinnedVersion: 1,
        skillId: first.skill.id,
      })
    ).toBe("repinned");
  });

  test("refuses to go past the per-agent cap", async () => {
    for (let index = 0; index < MAX_AGENT_SKILLS; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture setup
      await assignSkill(db, { agentId: "a1", skillId: `skill-${index}` });
    }

    expect(
      assignSkill(db, { agentId: "a1", skillId: "one-too-many" })
    ).rejects.toBeInstanceOf(SkillCapError);
  });
});
