import type { AgentSkillAssignment } from "#/modules/skills/service";
import { MAX_AGENT_SKILLS } from "#/modules/skills/validate";
import type { AgentSkillRef } from "./gateway";

/**
 * An agent's skills, reduced to the `skills` array `agents.update` takes. Pure,
 * so the whole composition is testable without a client.
 */

export interface ComposedSkills {
  /**
   * Assignments that could not be sent: not mirrored yet, pinned to a version
   * that was never mirrored, or past the cap. Reported on the agent's sync so
   * the reason is visible rather than silently missing.
   */
  dropped: { reason: string; slug: string }[];
  skills: AgentSkillRef[];
}

/**
 * The literal `"latest"` is what the API stores and hands back for an
 * unpinned skill, and it is resolved when a session is created - which is the
 * whole propagation mechanism: publishing a fix reaches every tracking agent
 * without any resync at all (verified by the Phase 5 entry spike).
 */
const LATEST = "latest";

const versionFor = (
  assignment: AgentSkillAssignment
): { reason: string } | { version: string } => {
  if (assignment.pinnedVersion === null) {
    return { version: LATEST };
  }
  if (!assignment.pinnedAnthropicVersion) {
    // A pin means "this exact version, or nothing". Falling back to latest here
    // would hand the agent the very version the pin exists to avoid.
    return {
      reason: `pinned to v${assignment.pinnedVersion}, which has not been mirrored yet`,
    };
  }
  return { version: assignment.pinnedAnthropicVersion };
};

export const composeAgentSkills = (
  assignments: readonly AgentSkillAssignment[]
): ComposedSkills => {
  const dropped: ComposedSkills["dropped"] = [];
  const skills: AgentSkillRef[] = [];

  for (const assignment of assignments) {
    if (!assignment.anthropicSkillId) {
      // Publishing failed (or never ran): the skill is usable locally and in
      // the UI, but there is nothing on Anthropic's side to attach.
      dropped.push({
        reason: "not mirrored to Anthropic yet",
        slug: assignment.slug,
      });
      continue;
    }
    const resolved = versionFor(assignment);
    if ("reason" in resolved) {
      dropped.push({ reason: resolved.reason, slug: assignment.slug });
      continue;
    }
    if (skills.length >= MAX_AGENT_SKILLS) {
      // Clamping is the backstop; assignment refuses to go past the cap in the
      // first place. Rows already over it must still produce a valid payload.
      dropped.push({
        reason: `over the ${MAX_AGENT_SKILLS}-skill cap`,
        slug: assignment.slug,
      });
      continue;
    }
    skills.push({
      skillId: assignment.anthropicSkillId,
      version: resolved.version,
    });
  }

  return { dropped, skills };
};
