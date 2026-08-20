import { useUser } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import { SkillSyncDot } from "#/components/skills/skill-status";
import { useSkills } from "#/lib/use-skills";
import { SectionHint, SidebarSection } from "./sidebar-section";

/**
 * The skills directory in the sidebar (plan 5e, first row): every skill with
 * its version and how it stands against its mirror. A row leads to the skill's
 * own page, which is where everything else about it lives.
 */

export const SKILLS_SECTION = "skills";

const rowClass =
  "ws-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-[var(--ws-muted)] no-underline hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]";

export function SkillsSection({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: (sectionKey: string) => void;
}) {
  const { isSignedIn } = useUser();
  const { skills } = useSkills(isSignedIn === true);

  return (
    <SidebarSection
      actions={
        <Link
          aria-label="New skill"
          className="ws-focus inline-flex h-7 w-7 items-center justify-center rounded-lg text-[var(--ws-muted)] no-underline hover:bg-[var(--ws-surface-hover)] hover:text-[var(--ws-text)]"
          search={{ new: true }}
          title="New skill"
          to="/skills"
        >
          <span aria-hidden="true">＋</span>
        </Link>
      }
      expanded={expanded}
      label="Skills"
      onToggle={onToggle}
      sectionKey={SKILLS_SECTION}
    >
      {skills.length === 0 ? (
        <SectionHint>No skills yet.</SectionHint>
      ) : (
        skills.map((skill) => (
          <Link
            className={rowClass}
            data-testid="sidebar-skill"
            key={skill.id}
            params={{ slug: skill.slug }}
            title={`${skill.name} - ${skill.description}`}
            to="/skills/$slug"
          >
            <SkillSyncDot status={skill.syncStatus} />
            <span className="truncate">{skill.name}</span>
            <span className="shrink-0 text-xs">v{skill.latestVersion}</span>
          </Link>
        ))
      )}
    </SidebarSection>
  );
}
