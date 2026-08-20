import type { Skill, SkillSyncStatus } from "#/lib/api";

/**
 * One vocabulary for how a skill stands against its Anthropic mirror, shared by
 * the sidebar, the directory, the detail view and the agent's picker. The
 * palette is the connectors' - accent for "in hand", danger for "broken", muted
 * for "not yet" - so a dot reads the same wherever it appears.
 */

const STATUS_COLORS: Record<SkillSyncStatus, string> = {
  error: "var(--ws-danger)",
  synced: "var(--ws-accent)",
  unsynced: "var(--ws-muted)",
};

export const SKILL_SYNC_LABELS: Record<SkillSyncStatus, string> = {
  error: "sync failed",
  synced: "synced",
  unsynced: "not synced yet",
};

/** Said wherever an unsynced skill can be picked: it is usable, just not yet live. */
export const UNSYNCED_NOTE = "reaches the agent once synced";

export function SkillSyncDot({ status }: { status: SkillSyncStatus }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: STATUS_COLORS[status] }}
    />
  );
}

/** The dot plus its word, for anywhere the status is the point of the row. */
export function SkillSyncLine({ skill }: { skill: Skill }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[var(--ws-muted)] text-xs"
      data-testid="skill-sync-status"
    >
      <SkillSyncDot status={skill.syncStatus} />
      <span>{SKILL_SYNC_LABELS[skill.syncStatus]}</span>
    </span>
  );
}

/**
 * Who wrote a skill or a version. The server stores `user` or `agent:<id>`; an
 * id means nothing on screen, so the agent's name is substituted when known.
 */
export const authorLabel = (
  createdBy: string,
  agentNames: ReadonlyMap<string, string>
): string => {
  if (!createdBy.startsWith("agent:")) {
    return "You";
  }
  const agentId = createdBy.slice("agent:".length);
  return `agent:${agentNames.get(agentId) ?? agentId}`;
};
