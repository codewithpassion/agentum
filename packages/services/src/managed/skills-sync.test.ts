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

const gateway = {
  createSkill: () => {
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
