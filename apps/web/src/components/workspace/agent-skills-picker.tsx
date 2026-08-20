import { useUser } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { SkillSyncDot, UNSYNCED_NOTE } from "#/components/skills/skill-status";
import {
  assignSkillToAgent,
  type Skill,
  unassignSkillFromAgent,
} from "#/lib/api";
import { useAgentSkills, useSkills } from "#/lib/use-skills";
// Straight from the server's rule, so the cap indicator cannot drift from it.
import { MAX_AGENT_SKILLS } from "#/modules/skills/validate";

/**
 * Which skills this agent may use, and which version each one is (plan 5e,
 * "Assign to agent"). Ticking a box writes straight through - there is no Save,
 * because the assignment is the whole change and the same click undoes it.
 *
 * The default is "latest", which is what makes a published fix reach the agent
 * on its next session; pinning is the escape hatch for an agent that must not
 * move.
 */

const LATEST = "latest";

/** `latest`, then every version that exists, newest first. */
const pinOptions = (latestVersion: number): number[] =>
  Array.from({ length: latestVersion }, (_, index) => latestVersion - index);

function SkillRow({
  busy,
  checked,
  disabled,
  onPin,
  onToggle,
  pinnedVersion,
  skill,
}: {
  busy: boolean;
  checked: boolean;
  disabled: boolean;
  onPin: (slug: string, pinnedVersion: number | null) => void;
  onToggle: (slug: string, next: boolean) => void;
  pinnedVersion: number | null;
  skill: Skill;
}) {
  const toggle = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      onToggle(skill.slug, event.target.checked),
    [onToggle, skill.slug]
  );
  const pin = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) =>
      onPin(
        skill.slug,
        event.target.value === LATEST ? null : Number(event.target.value)
      ),
    [onPin, skill.slug]
  );

  return (
    <li className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--ws-surface)]">
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-[13px]">
        <input
          checked={checked}
          disabled={busy || disabled}
          onChange={toggle}
          type="checkbox"
          value={skill.slug}
        />
        <SkillSyncDot status={skill.syncStatus} />
        <span className="truncate">{skill.name}</span>
        {skill.syncStatus === "synced" ? null : (
          <span className="shrink-0 text-[var(--ws-muted)] text-xs">
            ({UNSYNCED_NOTE})
          </span>
        )}
      </label>

      {checked ? (
        <select
          aria-label={`Version of ${skill.name}`}
          className="ws-focus shrink-0 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-1.5 py-1 text-[var(--ws-text)] text-xs"
          disabled={busy}
          onChange={pin}
          value={pinnedVersion === null ? LATEST : String(pinnedVersion)}
        >
          <option value={LATEST}>latest</option>
          {pinOptions(skill.latestVersion).map((version) => (
            <option key={version} value={String(version)}>
              v{version}
            </option>
          ))}
        </select>
      ) : null}
    </li>
  );
}

export function AgentSkillsPicker({ agentId }: { agentId: string }) {
  const { isSignedIn } = useUser();
  const signedIn = isSignedIn === true;
  const { error: listError, skills } = useSkills(signedIn);
  const {
    error: assignedError,
    reload,
    skills: assigned,
  } = useAgentSkills(agentId, signedIn);

  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pins = useMemo(
    () =>
      new Map(
        assigned.map((skill) => [skill.slug, skill.pinnedVersion] as const)
      ),
    [assigned]
  );

  const run = useCallback(
    (slug: string, work: () => Promise<unknown>) => {
      setBusySlug(slug);
      setError(null);
      (async () => {
        try {
          await work();
          await reload();
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : "That did not work."
          );
        } finally {
          setBusySlug(null);
        }
      })();
    },
    [reload]
  );

  const toggle = useCallback(
    (slug: string, next: boolean) =>
      run(slug, () =>
        next
          ? assignSkillToAgent(slug, agentId, null)
          : unassignSkillFromAgent(slug, agentId)
      ),
    [agentId, run]
  );

  const pin = useCallback(
    (slug: string, pinnedVersion: number | null) =>
      run(slug, () => assignSkillToAgent(slug, agentId, pinnedVersion)),
    [agentId, run]
  );

  const shown = listError ?? assignedError ?? error;

  return (
    <div className="space-y-3">
      <p
        className="m-0 text-[var(--ws-muted)] text-xs"
        data-testid="skills-cap-note"
      >
        {assigned.length} of {MAX_AGENT_SKILLS} skills.
      </p>

      {skills.length === 0 ? (
        <p className="m-0 text-[var(--ws-muted)] text-xs">
          No skills yet.{" "}
          <Link className="text-[var(--ws-accent)]" to="/skills">
            Write one
          </Link>
          .
        </p>
      ) : (
        <ul className="m-0 list-none space-y-1 p-0">
          {skills.map((skill) => {
            const checked = pins.has(skill.slug);
            return (
              <SkillRow
                busy={busySlug === skill.slug}
                checked={checked}
                // The cap is the server's rule; the UI only stops the click
                // that would break it.
                disabled={!checked && assigned.length >= MAX_AGENT_SKILLS}
                key={skill.id}
                onPin={pin}
                onToggle={toggle}
                pinnedVersion={pins.get(skill.slug) ?? null}
                skill={skill}
              />
            );
          })}
        </ul>
      )}

      <p className="m-0 text-[var(--ws-muted)] text-xs">
        Tracking latest is the default, so a published fix reaches this agent on
        its next session. Pin a version to hold it still.
      </p>

      {shown ? (
        <p className="m-0 text-[var(--ws-danger)] text-xs">{shown}</p>
      ) : null}
    </div>
  );
}
