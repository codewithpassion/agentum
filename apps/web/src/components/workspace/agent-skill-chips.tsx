import { Link } from "@tanstack/react-router";
import {
  SKILL_SYNC_LABELS,
  SkillSyncDot,
} from "#/components/skills/skill-status";
import { useAgentSkills } from "#/lib/use-skills";

/**
 * The skills the agent holds, where the agent is (plan 5e, last row): one chip
 * per assignment, badged with the pinned version when it is not tracking
 * latest, each linking to the skill itself.
 */
export function AgentSkillChips({ agentId }: { agentId: string }) {
  const { skills } = useAgentSkills(agentId, true);

  return (
    <section className="space-y-2">
      <h3 className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
        Skills
      </h3>
      {skills.length === 0 ? (
        <p className="m-0 text-[var(--ws-muted)] text-xs">
          No skills yet. Add one from Edit → Skills.
        </p>
      ) : (
        <ul
          className="m-0 flex list-none flex-wrap gap-1.5 p-0"
          data-testid="agent-skill-chips"
        >
          {skills.map((skill) => (
            <li key={skill.id}>
              <Link
                className="ws-focus inline-flex items-center gap-1.5 rounded-lg border border-[var(--ws-line)] px-2 py-1 text-[var(--ws-muted)] text-xs no-underline hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
                params={{ slug: skill.slug }}
                title={`${skill.name} - ${SKILL_SYNC_LABELS[skill.syncStatus]}`}
                to="/skills/$slug"
              >
                <SkillSyncDot status={skill.syncStatus} />
                <span className="truncate">{skill.name}</span>
                {skill.pinnedVersion === null ? null : (
                  <span className="shrink-0">v{skill.pinnedVersion}</span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
