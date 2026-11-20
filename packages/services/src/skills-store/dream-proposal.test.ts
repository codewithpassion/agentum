import { expect, test } from "bun:test";
import {
  A1,
  B1,
  readOnlyUser,
  run,
  setup,
  skillMd,
  user,
} from "./test-support.ts";

const input = {
  agentId: A1,
  files: [{ content: skillMd("report-summary"), path: "SKILL.md" }],
  message: "Summarize reports",
  name: "report-summary",
};

test("a dream proposes as its agent without a run and uses the existing approval flow", async () => {
  const { service } = setup();
  const { skill, version } = await service.proposeForAgent(user(), input);
  expect(skill.ownerAgentId).toBe(A1);
  expect(skill.latestApprovedVersion).toBeNull();
  expect(version.author).toEqual({ id: A1, kind: "agent", runId: null });
  expect(version.status).toBe("proposed");
  expect(await service.proposals(user())).toEqual([version]);
  await service.approve(user(), { skillId: skill.id, version: 1 });
  expect(await service.proposals(user())).toEqual([]);
  expect((await service.list(user()))[0]?.latestApprovedVersion).toBe(1);
});
test("dream proposal creation refuses other workspaces, runs and read-only callers", async () => {
  const { service } = setup();
  await expect(
    service.proposeForAgent(user(), { ...input, agentId: B1 })
  ).rejects.toThrow();
  await expect(service.proposeForAgent(run(), input)).rejects.toThrow();
  await expect(
    service.proposeForAgent(readOnlyUser(), input)
  ).rejects.toThrow();
});
