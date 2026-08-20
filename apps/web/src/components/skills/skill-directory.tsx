import { Link } from "@tanstack/react-router";
import { Button } from "#/components/ui/button";
import type { Skill } from "#/lib/api";
import { authorLabel, SKILL_SYNC_LABELS, SkillSyncDot } from "./skill-status";

/**
 * The skills directory (plan 5e, first row): what exists, what each one is for,
 * where it stands and who wrote it. A row leads to the skill's own page, which
 * is where everything else about it lives.
 */

export function SkillDirectory({
  agentNames,
  onNew,
  skills,
}: {
  agentNames: ReadonlyMap<string, string>;
  onNew: () => void;
  skills: Skill[];
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-4">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 className="m-0 font-semibold text-lg">Skills</h2>
            <p className="m-0 text-[var(--ws-muted)] text-sm">
              A skill is a SKILL.md and the files it needs. Agents read the ones
              you assign them, and can write their own.
            </p>
          </div>
          <Button data-testid="new-skill" onClick={onNew} variant="primary">
            New skill
          </Button>
        </header>

        {skills.length === 0 ? (
          <p className="m-0 text-[var(--ws-muted)] text-sm">
            No skills yet. Write the first one.
          </p>
        ) : (
          <ul
            className="m-0 list-none space-y-1 p-0"
            data-testid="skill-directory"
          >
            {skills.map((skill) => (
              <li key={skill.id}>
                <Link
                  className="ws-focus block rounded-lg border border-[var(--ws-line)] px-3 py-2 no-underline hover:bg-[var(--ws-surface)]"
                  params={{ slug: skill.slug }}
                  to="/skills/$slug"
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-[13px] text-[var(--ws-text)]">
                      {skill.name}
                    </span>
                    <span className="shrink-0 text-[var(--ws-muted)] text-xs">
                      v{skill.latestVersion}
                    </span>
                    <SkillSyncDot status={skill.syncStatus} />
                    <span className="shrink-0 text-[var(--ws-muted)] text-xs">
                      {SKILL_SYNC_LABELS[skill.syncStatus]}
                    </span>
                  </span>
                  <span className="mt-0.5 block truncate text-[var(--ws-muted)] text-xs">
                    {skill.description}
                  </span>
                  <span className="block text-[var(--ws-muted)] text-xs">
                    by {authorLabel(skill.createdBy, agentNames)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
