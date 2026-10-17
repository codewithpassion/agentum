import { describe, expect, test } from "bun:test";
import { createRunSkillsService } from "../run-skills.ts";
import {
  A1,
  createSkill,
  decode,
  R1,
  run,
  setup,
  skillMd,
  user,
  W1,
} from "../skills-store/test-support.ts";
import { createManagedSkillsSource } from "./skills-source.ts";

const build = () => {
  const harness = setup();
  const source = createManagedSkillsSource(
    {
      runSkills: createRunSkillsService({ skillsStore: harness.service }),
      skillsStore: harness.service,
    },
    { agentId: A1, id: R1, workspaceId: W1 }
  );
  return { ...harness, source };
};

describe("the managed skills source", () => {
  test("lists the assigned skills at the latest approved version, with the files of that version", async () => {
    const { service, source } = build();
    const { skill } = await createSkill(service, "shout", {
      "scripts/run.ts": "go()",
    });
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    const [listed] = await source.list();
    expect(listed).toMatchObject({
      name: "shout",
      pinned: false,
      skillId: skill.id,
      version: 1,
    });
    const files = await source.files(skill.id, 1);
    expect(
      files.map((file) => [file.path, decode(file.content)]).sort()
    ).toEqual([
      ["SKILL.md", skillMd("shout")],
      ["scripts/run.ts", "go()"],
    ]);
  });

  test("a pin wins over a newer approved version", async () => {
    const { service, source } = build();
    const { skill } = await createSkill(service, "shout");
    await service.commit(user(), {
      baseVersion: 1,
      deletes: [],
      message: "Second",
      skillId: skill.id,
      writes: [{ content: skillMd("shout", "Second."), path: "SKILL.md" }],
    });
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    expect((await source.list())[0]).toMatchObject({ version: 2 });
    await service.pin(user(), { agentId: A1, skillId: skill.id, version: 1 });
    expect((await source.list())[0]).toMatchObject({
      pinned: true,
      version: 1,
    });
  });

  test("a proposed version is never listed", async () => {
    const { service, source } = build();
    const { skill } = await service.create(run(A1, R1), {
      files: [{ content: skillMd("shout"), path: "SKILL.md" }],
      message: "Draft",
      name: "shout",
    });
    await service.assign(user(), { agentId: A1, skillId: skill.id });
    expect(await source.list()).toEqual([]);
    await service.approve(user(), { skillId: skill.id, version: 1 });
    await service.commit(run(A1, R1), {
      baseVersion: 1,
      deletes: [],
      message: "Proposal",
      skillId: skill.id,
      writes: [{ content: skillMd("shout", "Proposed."), path: "SKILL.md" }],
    });
    const [listed] = await source.list();
    expect(listed?.version).toBe(1);
  });
});
