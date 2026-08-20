import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";
import { createAgent } from "#/modules/agents/service";
import {
  assignSkill,
  getAgentSkill,
  getSkillBySlug,
  listSkillVersions,
} from "#/modules/skills/service";
import { MAX_AGENT_SKILLS } from "#/modules/skills/validate";
import { DEFAULT_WORKSPACE_ID } from "#/modules/workspaces/service";
import { skillCreate, skillList, skillRead, skillUpdate } from "./skill-tools";
import type { McpToolContext } from "./tools";

/**
 * The agents' half of skills, against the shipped migrations and a faked R2.
 * No Anthropic key is configured, so the mirror is off: every assertion here is
 * about what the agent gets back and what the workspace records, which is
 * exactly the part that must work with or without the API.
 */

const FRONTMATTER = /frontmatter/;
const USE_SKILL_UPDATE = /skill_update/;
const NOT_ASSIGNED = /not assigned to you/;
const CHANGELOG_TEXT = /assumed bash/;
const USE_SKILL_CREATE = /skill_create/;
const NO_SUCH_VERSION = /has no version 7/;
const USE_SKILL_LIST = /skill_list/;

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

const fakeBucket = (): R2Bucket => {
  const objects = new Map<string, string>();
  return {
    delete(key: string) {
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
      objects.set(key, value);
      return Promise.resolve({});
    },
  } as unknown as R2Bucket;
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

const payloadOf = (result: CallToolResult): Record<string, unknown> => {
  const [block] = result.content;
  if (block?.type !== "text") {
    throw new Error("expected a text block");
  }
  return JSON.parse(block.text) as Record<string, unknown>;
};

const textOf = (result: CallToolResult): string => {
  const [block] = result.content;
  return block?.type === "text" ? block.text : "";
};

let db: Db;
let ctx: McpToolContext;
let agent: Agent;

beforeEach(async () => {
  db = migrate();
  ({ agent } = await createAgent(db, DEFAULT_WORKSPACE_ID, {
    instructions: "",
    name: "Ada",
    soul: "",
  }));
  ctx = {
    agent,
    db,
    // No ANTHROPIC_API_KEY: the mirror is off, and the tools must still work.
    env: { ATTACHMENTS: fakeBucket() } as unknown as Env,
    requestUrl: "https://app.example.com/mcp/tok",
  };
});

const createDefault = () =>
  skillCreate(ctx, {
    changelog: "Because we do this every Monday.",
    files: filesFor("v1 body", "run v1\n"),
    slug: SLUG,
  });

describe("skill_create", () => {
  test("publishes version 1 and assigns it to the calling agent", async () => {
    const result = await createDefault();
    const payload = payloadOf(result);

    expect(payload.version).toBe(1);
    expect(payload.assignedToYou).toBe(true);
    // Unsynced is not a failure - the skill is stored and readable.
    expect(payload.synced).toBe(false);

    const skill = await getSkillBySlug(db, SLUG);
    expect(skill?.createdBy).toBe(`agent:${agent.id}`);
    const pin = await getAgentSkill(db, skill?.id ?? "", agent.id);
    // Tracking latest is what makes a later fix propagate.
    expect(pin?.pinnedVersion).toBeNull();
  });

  test("attributes the version to the calling agent", async () => {
    await createDefault();
    const skill = await getSkillBySlug(db, SLUG);
    const [version] = await listSkillVersions(db, skill?.id ?? "");

    expect(version?.createdBy).toBe(`agent:${agent.id}`);
    expect(version?.changelog).toBe("Because we do this every Monday.");
  });

  test("refuses an invalid skill with the reason", async () => {
    const result = await skillCreate(ctx, {
      files: [{ content: "# no frontmatter\n", path: "SKILL.md" }],
      slug: SLUG,
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(FRONTMATTER);
    expect(await getSkillBySlug(db, SLUG)).toBeUndefined();
  });

  test("points at skill_update when the slug is taken", async () => {
    await createDefault();

    const again = await createDefault();

    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(USE_SKILL_UPDATE);
  });

  test("keeps the skill when the agent is at its assignment cap", async () => {
    for (let index = 0; index < MAX_AGENT_SKILLS; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential fixture setup
      await assignSkill(db, { agentId: agent.id, skillId: `filler-${index}` });
    }

    const payload = payloadOf(await createDefault());

    // The skill is worth having in the workspace either way; only the
    // assignment is refused, and the agent is told why.
    expect(payload.version).toBe(1);
    expect(payload.assignedToYou).toBe(false);
    expect(String(payload.note)).toMatch(NOT_ASSIGNED);
    expect(await getSkillBySlug(db, SLUG)).toBeDefined();
  });
});

describe("skill_update", () => {
  test("publishes a new version without touching the old one", async () => {
    await createDefault();
    const skill = await getSkillBySlug(db, SLUG);
    const before = await listSkillVersions(db, skill?.id ?? "");

    const payload = payloadOf(
      await skillUpdate(ctx, {
        changelog: "fixed: script assumed bash, the sandbox runs sh",
        files: filesFor("v2 body", "run v2\n"),
        slug: SLUG,
      })
    );

    expect(payload.version).toBe(2);
    const after = await listSkillVersions(db, skill?.id ?? "");
    expect(after.at(-1)).toEqual(before[0] as never);
    expect(after[0]?.changelog).toMatch(CHANGELOG_TEXT);
    expect(after[0]?.createdBy).toBe(`agent:${agent.id}`);
  });

  test("says so when the skill does not exist", async () => {
    const result = await skillUpdate(ctx, {
      changelog: "fix",
      files: filesFor("body", "run\n"),
      slug: "nothing-here",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(USE_SKILL_CREATE);
  });

  test("refuses a file set that no longer validates", async () => {
    await createDefault();

    const result = await skillUpdate(ctx, {
      changelog: "oops",
      files: [{ content: "no frontmatter", path: "SKILL.md" }],
      slug: SLUG,
    });

    expect(result.isError).toBe(true);
    expect((await getSkillBySlug(db, SLUG))?.latestVersion).toBe(1);
  });
});

describe("skill_list", () => {
  test("marks the skills assigned to the caller", async () => {
    await createDefault();

    const payload = payloadOf(await skillList(ctx));
    const [entry] = payload.skills as Record<string, unknown>[];

    expect(entry?.slug).toBe(SLUG);
    expect(entry?.assignedToYou).toBe(true);
    expect(entry?.latestVersion).toBe(1);
    expect(entry?.description).toBe("Build the weekly report.");
  });

  test("shows a skill the caller does not have as unassigned", async () => {
    await createDefault();
    const other = ctx.agent;
    const payload = payloadOf(
      await skillList({ ...ctx, agent: { ...other, id: "someone-else" } })
    );

    expect(
      (payload.skills as Record<string, unknown>[])[0]?.assignedToYou
    ).toBe(false);
  });
});

describe("skill_read", () => {
  test("returns SKILL.md, the file list and the history", async () => {
    await createDefault();

    const payload = payloadOf(await skillRead(ctx, { slug: SLUG }));

    expect(payload.version).toBe(1);
    expect((payload.contents as Record<string, string>)["SKILL.md"]).toContain(
      "v1 body"
    );
    expect((payload.files as { path: string }[]).map((f) => f.path)).toEqual([
      "SKILL.md",
      "scripts/run.ts",
    ]);
    expect((payload.versions as unknown[]).length).toBe(1);
  });

  test("returns the contents of the files asked for", async () => {
    await createDefault();

    const payload = payloadOf(
      await skillRead(ctx, { paths: ["scripts/run.ts"], slug: SLUG })
    );

    expect((payload.contents as Record<string, string>)["scripts/run.ts"]).toBe(
      "run v1\n"
    );
  });

  test("reads an older version verbatim after an update", async () => {
    await createDefault();
    await skillUpdate(ctx, {
      changelog: "second",
      files: filesFor("v2 body", "run v2\n"),
      slug: SLUG,
    });

    const first = payloadOf(await skillRead(ctx, { slug: SLUG, version: 1 }));

    expect((first.contents as Record<string, string>)["SKILL.md"]).toContain(
      "v1 body"
    );
  });

  test("names the versions it does have when one is missing", async () => {
    await createDefault();

    const result = await skillRead(ctx, { slug: SLUG, version: 7 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(NO_SUCH_VERSION);
  });

  test("says so when the slug is unknown", async () => {
    const result = await skillRead(ctx, { slug: "nothing-here" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(USE_SKILL_LIST);
  });
});
