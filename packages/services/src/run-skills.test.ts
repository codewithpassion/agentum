import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { SKILLS_MAX_FILES } from "@repo/protocol/skills";
import { ForbiddenError } from "./authz.ts";
import { isServiceError } from "./errors.ts";
import { createRunSkillsService } from "./run-skills.ts";
import {
  A1,
  A2,
  bytes,
  createSkill,
  decode,
  errorOf,
  R1,
  R2,
  run,
  setup,
  skillMd,
  user,
} from "./skills-store/test-support.ts";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const build = () => {
  const harness = setup();
  const runSkills = createRunSkillsService({ skillsStore: harness.service });
  return { ...harness, runSkills };
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  const error = await errorOf(promise);
  return isServiceError(error) ? error.code : "none";
};

describe("list and read", () => {
  test("the skills of the run's agent come from the store, in the folder layout", async () => {
    const { runSkills, service } = build();
    const { skill } = await createSkill(service, "shout", {
      "scripts/run.ts": "console.log(1)",
    });
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    const files = await runSkills.list(run(A1, R1), R1);
    expect(files).toEqual([
      {
        etag: sha256(skillMd("shout")),
        executable: false,
        path: "shout/SKILL.md",
        size: bytes(skillMd("shout")).byteLength,
      },
      {
        etag: sha256("console.log(1)"),
        executable: false,
        path: "shout/scripts/run.ts",
        size: bytes("console.log(1)").byteLength,
      },
    ]);
    expect(
      decode(await runSkills.read(run(A1, R1), R1, "shout/scripts/run.ts"))
    ).toBe("console.log(1)");
  });

  test("the executable flag is kept", async () => {
    const { runSkills, service } = build();
    const { skill } = await service.create(user(), {
      files: [
        { content: skillMd("tool"), path: "SKILL.md" },
        { content: "#!/bin/sh\n", executable: true, path: "run.sh" },
      ],
      message: "First",
      name: "tool",
    });
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    const files = await runSkills.list(run(A1, R1), R1);
    expect(files.map((file) => [file.path, file.executable])).toEqual([
      ["tool/SKILL.md", false],
      ["tool/run.sh", true],
    ]);
  });

  test("a skill the agent does not carry is not listed or readable", async () => {
    const { runSkills, service } = build();
    await createSkill(service, "unassigned");
    expect(await runSkills.list(run(A1, R1), R1)).toEqual([]);
    expect(
      await codeOf(runSkills.read(run(A1, R1), R1, "unassigned/SKILL.md"))
    ).toBe("not_found");
  });

  test("the latest approved version is used, and a pin wins over it", async () => {
    const { runSkills, service } = build();
    const { skill } = await createSkill(service, "pinned-skill");
    await service.commit(user(), {
      baseVersion: 1,
      deletes: [],
      message: "Second",
      skillId: skill.id,
      writes: [
        { content: skillMd("pinned-skill", "Second."), path: "SKILL.md" },
      ],
    });
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    const read = async () =>
      decode(await runSkills.read(run(A1, R1), R1, "pinned-skill/SKILL.md"));
    expect(await read()).toContain("Second.");
    await service.pin(user(), { agentId: A1, skillId: skill.id, version: 1 });
    expect(await read()).toContain("Do the thing.");
    const listed = await runSkills.list(run(A1, R1), R1);
    expect(listed[0]?.etag).toBe(sha256(skillMd("pinned-skill")));
  });

  test("a proposed version is never in the default set", async () => {
    const { runSkills, service } = build();
    const { skill } = await service.create(run(A1, R1), {
      files: [{ content: skillMd("shout"), path: "SKILL.md" }],
      message: "Draft",
      name: "shout",
    });
    await service.approve(user(), { skillId: skill.id, version: 1 });
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    await service.commit(run(A1, R1), {
      baseVersion: 1,
      deletes: [],
      message: "Proposal",
      skillId: skill.id,
      writes: [{ content: skillMd("shout", "Proposed."), path: "SKILL.md" }],
    });
    const text = decode(
      await runSkills.read(run(A1, R1), R1, "shout/SKILL.md")
    );
    expect(text).toContain("Do the thing.");
    expect(text).not.toContain("Proposed.");
  });

  test("a skill with only a proposed version is left out", async () => {
    const { runSkills, service } = build();
    await service.create(run(A1, R1), {
      files: [{ content: skillMd("draft"), path: "SKILL.md" }],
      message: "Draft",
      name: "draft",
    });
    expect(await runSkills.list(run(A1, R1), R1)).toEqual([]);
  });

  test("a path that leaves the skill folder is invalid", async () => {
    const { runSkills } = build();
    for (const path of [
      "../a1/x/SKILL.md",
      "x/../y",
      "/x/SKILL.md",
      "",
      "x\\y",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: one path at a time keeps failures readable
      expect(await codeOf(runSkills.read(run(A1, R1), R1, path)), path).toBe(
        "invalid"
      );
    }
  });

  test("only a run of the agent reads, and only as itself", async () => {
    const { runSkills, service } = build();
    const { skill } = await createSkill(service, "shout");
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    expect(await errorOf(runSkills.list(user(), R1))).toBeInstanceOf(
      ForbiddenError
    );
    expect(await codeOf(runSkills.list(run(A1, R1), R2))).toBe("not_found");
    expect(await errorOf(runSkills.resolve(run(A2, R2), R2))).toBeNull();
    expect(await runSkills.list(run(A2, R2), R2)).toEqual([]);
  });

  test("skills over the file cap are refused as a set", async () => {
    const { runSkills, service } = build();
    const many = (prefix: string, count: number) =>
      Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `f/${prefix}${index}`,
          "x",
        ])
      );
    const first = await createSkill(
      service,
      "first",
      many("a", SKILLS_MAX_FILES - 1)
    );
    const second = await createSkill(service, "second", many("b", 5));
    await service.assign(user(), { agentId: A1, skillId: first.skill.id });
    expect((await runSkills.list(run(A1, R1), R1)).length).toBe(
      SKILLS_MAX_FILES
    );
    await service.assign(user(), { agentId: A1, skillId: second.skill.id });
    expect(await codeOf(runSkills.list(run(A1, R1), R1))).toBe("invalid");
  });
});
