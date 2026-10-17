/**
 * The skills of a managed run's agent, from the central skills store (SK.2).
 * `list` is the set a run reads (pinned or latest approved versions, within the
 * caps) and `files` reads one of those versions with its contents.
 */
import type { RunSkillsService } from "../run-skills.ts";
import type { RunRecord } from "../runs/types.ts";
import type { SkillsStoreService } from "../skills-store.ts";
import type { SkillsSource } from "./skills-sync.ts";

export const createManagedSkillsSource = (
  services: {
    runSkills: Pick<RunSkillsService, "resolve">;
    skillsStore: Pick<SkillsStoreService, "show">;
  },
  run: Pick<RunRecord, "agentId" | "id" | "workspaceId">
): SkillsSource => {
  const principal = {
    agentId: run.agentId,
    kind: "run",
    runId: run.id,
    workspaceId: run.workspaceId,
  } as const;
  return {
    files: async (skillId, version) => {
      const shown = await services.skillsStore.show(principal, {
        skillId,
        version,
        withContents: true,
      });
      return shown.files.map((file) => ({
        content: file.content ?? new Uint8Array(),
        path: file.path,
      }));
    },
    list: () => services.runSkills.resolve(principal, run.id),
  };
};
