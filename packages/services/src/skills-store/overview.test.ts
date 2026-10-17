import { expect, test } from "bun:test";
import {
  A1,
  A2,
  createSkill,
  R1,
  run,
  setup,
  skillMd,
  user,
  W2,
} from "./test-support.ts";

test("assignments lists every assignment with its pinned version number", async () => {
  const { service } = setup();
  const { skill: brief } = await createSkill(service, "brief");
  const { skill: notes } = await createSkill(service, "notes");
  await service.assign(user(), { agentId: A1, skillId: brief.id });
  await service.assign(user(), { agentId: A2, skillId: brief.id });
  await service.assign(user(), { agentId: A1, skillId: notes.id });
  await service.pin(user(), { agentId: A2, skillId: brief.id, version: 1 });

  const rows = await service.assignments(user());
  expect(rows).toHaveLength(3);
  expect(rows).toContainEqual({
    agentId: A1,
    pinnedVersion: null,
    skillId: brief.id,
  });
  expect(rows).toContainEqual({
    agentId: A2,
    pinnedVersion: 1,
    skillId: brief.id,
  });
  expect(rows).toContainEqual({
    agentId: A1,
    pinnedVersion: null,
    skillId: notes.id,
  });
});

test("assignments stays inside the workspace and a run sees only its own agent", async () => {
  const { service } = setup();
  const { skill } = await createSkill(service, "brief");
  await service.assign(user(), { agentId: A1, skillId: skill.id });
  await service.assign(user(), { agentId: A2, skillId: skill.id });

  expect(await service.assignments(user(W2))).toEqual([]);
  expect(await service.assignments(run(A1, R1))).toEqual([
    { agentId: A1, pinnedVersion: null, skillId: skill.id },
  ]);
});

const proposeAs = (
  service: ReturnType<typeof setup>["service"],
  agentId: string,
  runId: string,
  name: string
) =>
  service.create(run(agentId, runId), {
    files: [{ content: skillMd(name), path: "SKILL.md" }],
    message: "Agent draft",
    name,
  });

test("proposals lists proposed versions only and drops them once decided", async () => {
  const { service } = setup();
  await createSkill(service, "brief");
  expect(await service.proposals(user())).toEqual([]);

  const { skill, version } = await proposeAs(service, A1, R1, "mine");
  expect(version.status).toBe("proposed");

  const waiting = await service.proposals(user());
  expect(waiting.map((entry) => [entry.skillId, entry.number])).toEqual([
    [skill.id, 1],
  ]);
  expect(waiting[0].author.kind).toBe("agent");

  await service.approve(user(), { skillId: skill.id, version: 1 });
  expect(await service.proposals(user())).toEqual([]);
});

test("a run sees only its own agent's proposals", async () => {
  const { service } = setup();
  await proposeAs(service, A1, R1, "mine");

  expect(await service.proposals(run(A1, R1))).toHaveLength(1);
  expect(await service.proposals(run(A2, "r2"))).toEqual([]);
  expect(await service.proposals(user(W2))).toEqual([]);
});
