import { expect, test } from "bun:test";
import type { Principal } from "../workspaces.ts";
import { A1, B1, run, setup, skillMd, user, W1 } from "./test-support.ts";

const dreamPrincipal = (): Principal => ({
  dream: true,
  kind: "user",
  userId: "dream:a1",
  via: "session",
  workspaceId: W1,
});

const input = {
  agentId: A1,
  files: [{ content: skillMd("report-summary"), path: "SKILL.md" }],
  message: "Summarize reports",
  name: "report-summary",
};

test("a dream proposes as its agent without a run and uses the existing approval flow", async () => {
  const { service } = setup();
  const dream = dreamPrincipal();
  const { skill, version } = await service.proposeForAgent(dream, input);
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
  const dream = dreamPrincipal();
  await expect(
    service.proposeForAgent(dream, { ...input, agentId: B1 })
  ).rejects.toThrow();
  await expect(service.proposeForAgent(user(), input)).rejects.toThrow();
  await expect(service.proposeForAgent(run(), input)).rejects.toThrow();
  await expect(
    service.proposeForAgent(
      {
        apiKey: { access: "read", id: "k1" },
        dream: true,
        kind: "user",
        userId: "u1",
        via: "api_key",
        workspaceId: W1,
      },
      input
    )
  ).rejects.toThrow();
});
