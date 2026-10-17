import type { SkillsStoreService } from "@repo/services/skills-store";
import type { Principal } from "@repo/services/workspaces";
import type { SkillVersionFiles } from "./run-skill-script.ts";

/**
 * Reads one version of a skill for a run, so it can run that version's
 * script. The store decides what the run may read: an approved version of a
 * skill its agent owns or carries, and the agent's own proposals. Anything
 * else is "not found". When the agent owns a skill and carries another of the
 * same name, its own is the one meant.
 */
export const skillVersionFiles =
  (
    store: Pick<SkillsStoreService, "list" | "show">,
    principal: Principal
  ): SkillVersionFiles =>
  async (name, version) => {
    const named = (await store.list(principal)).filter(
      (candidate) => candidate.name === name
    );
    const own =
      principal.kind === "run"
        ? named.find((entry) => entry.ownerAgentId === principal.agentId)
        : undefined;
    const skill = own ?? named[0];
    if (skill === undefined) {
      throw new Error(`No skill named ${name} that this agent can read.`);
    }
    const shown = await store.show(principal, {
      skillId: skill.id,
      version,
      withContents: true,
    });
    return shown.files.map((file) => ({
      bytes: file.content ?? new Uint8Array(),
      path: file.path,
    }));
  };
