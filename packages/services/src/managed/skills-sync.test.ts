import { beforeEach, describe, expect, test } from "bun:test";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import type { ResolvedSkill } from "../skills-store/records.ts";
import type { SkillUploadFile } from "./gateway.ts";
import { createSkillsSync, type SkillsSource } from "./skills-sync.ts";

const START = "2026-10-18T10:00:00.000Z";
const WORKSPACE = "w1";

let db: ReturnType<typeof migrated>;
let created: string[];
let versioned: { skillId: string }[];
let fetched: string[];
let titles: string[];

const gateway = {
  createSkill: (input: { displayTitle: string }) => {
    titles.push(input.displayTitle);
    created.push(`skill_${created.length + 1}`);
    return Promise.resolve({
      skillId: `skill_${created.length}`,
      version: "1",
    });
  },
  createSkillVersion: (input: { skillId: string }) => {
    versioned.push(input);
    return Promise.resolve(String(versioned.length + 1));
  },
  deleteSkill: () => Promise.resolve(),
};

const source: SkillsSource = {
  files: (skillId, version) => {
    fetched.push(`${skillId}@${version}`);
    const files: SkillUploadFile[] = [
      { content: new Uint8Array(), path: "SKILL.md" },
    ];
    return Promise.resolve(files);
  },
  list: () => Promise.resolve([]),
};

const resolved = (skillId: string, version: number): ResolvedSkill => ({
  files: [],
  name: "shout",
  pinned: false,
  skillId,
  version,
});

beforeEach(() => {
  db = migrated();
  created = [];
  versioned = [];
  fetched = [];
  titles = [];
  db.insert(workspaces)
    .values({
      clerkOrgId: "org_w1",
      createdAt: START,
      id: WORKSPACE,
      name: "w1",
      timezone: "UTC",
    })
    .run();
});

const sync = (agentId: string, skills: ResolvedSkill[]) =>
  createSkillsSync({ db, now: () => START }).sync({
    agent: { id: agentId, workspaceId: WORKSPACE },
    gateway,
    skills,
    source,
  });

describe("skills sync", () => {
  test("a new skill's display title stays within the 64 characters Anthropic accepts", async () => {
    // A built-in skill id carries the workspace id, which made the title 82 characters.
    await sync("a1", [
      resolved("builtin-library-transfer-01M538QZWS1B9PAQ3J8X2JMRF6", 1),
    ]);

    expect(titles).toHaveLength(1);
    expect(titles[0]?.length).toBeLessThanOrEqual(64);
  });

  test("a version is uploaded once and shared by every agent that carries it", async () => {
    const first = await sync("a1", [resolved("hm1", 1)]);
    const second = await sync("a2", [resolved("hm1", 1)]);

    expect(created).toEqual(["skill_1"]);
    expect(fetched).toEqual(["hm1@1"]);
    expect(second.refs).toEqual(first.refs);
    expect(first.refs).toEqual([{ skillId: "skill_1", version: "1" }]);
  });

  test("another version of a skill is a version of the same Anthropic skill", async () => {
    await sync("a1", [resolved("hm1", 1)]);
    const next = await sync("a2", [resolved("hm1", 2)]);

    expect(created).toEqual(["skill_1"]);
    expect(versioned).toEqual([
      expect.objectContaining({ skillId: "skill_1" }),
    ]);
    expect(next.refs).toEqual([{ skillId: "skill_1", version: "2" }]);
  });

  test("different skills get their own Anthropic skills", async () => {
    const synced = await sync("a1", [resolved("hm1", 1), resolved("hm2", 1)]);

    expect(synced.refs.map((ref) => ref.skillId)).toEqual([
      "skill_1",
      "skill_2",
    ]);
  });
});
