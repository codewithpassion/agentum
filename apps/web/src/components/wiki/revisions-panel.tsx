import { useCallback } from "react";
import { Button } from "#/components/ui/button";
import type { WikiRevision } from "#/lib/api";
import { cx } from "#/lib/cx";
import { formatDay, formatTime } from "#/lib/format";

const authorLabel = (
  revision: WikiRevision,
  agentNames: ReadonlyMap<string, string>
): string => {
  if (revision.authorType === "agent") {
    return agentNames.get(revision.authorId) ?? "Agent";
  }
  return revision.author ? revision.author.name : "Former member";
};

function RevisionRow({
  active,
  agentNames,
  index,
  onView,
  revision,
}: {
  active: boolean;
  agentNames: ReadonlyMap<string, string>;
  index: number;
  onView: (revision: WikiRevision) => void;
  revision: WikiRevision;
}) {
  const view = useCallback(() => onView(revision), [onView, revision]);
  const at = revision.createdAt;

  return (
    <li>
      <button
        className={cx(
          "ws-focus w-full rounded-lg px-2 py-1.5 text-left text-[13px]",
          active
            ? "bg-[var(--ws-surface-hover)] text-[var(--ws-text)]"
            : "text-[var(--ws-muted)] hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
        )}
        onClick={view}
        type="button"
      >
        <span className="block font-medium text-[var(--ws-text)]">
          Revision {index}
        </span>
        <span className="block text-[var(--ws-muted)] text-xs">
          {authorLabel(revision, agentNames)} · {formatDay(at)} {formatTime(at)}
        </span>
      </button>
    </li>
  );
}

/**
 * Revisions are listed newest first, but numbered oldest first, so "Revision 1"
 * stays the same entry as the page grows.
 */
export function RevisionsPanel({
  agentNames,
  onClose,
  onView,
  revisions,
  viewingId,
}: {
  agentNames: ReadonlyMap<string, string>;
  onClose: () => void;
  onView: (revision: WikiRevision) => void;
  revisions: WikiRevision[];
  viewingId: string | null;
}) {
  return (
    <aside
      className="flex w-72 shrink-0 flex-col border-[var(--ws-line)] border-l bg-[var(--ws-panel)]"
      data-testid="wiki-revisions"
    >
      <div className="flex items-center justify-between gap-2 border-[var(--ws-line)] border-b px-3 py-3">
        <span className="font-semibold text-sm">History</span>
        <Button
          aria-label="Close history"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <span aria-hidden="true">✕</span>
        </Button>
      </div>
      <ul className="m-0 flex-1 list-none overflow-y-auto p-2">
        {revisions.length === 0 ? (
          <li className="px-2 py-1 text-[var(--ws-muted)] text-xs">
            No revisions yet.
          </li>
        ) : null}
        {revisions.map((revision, position) => (
          <RevisionRow
            active={revision.id === viewingId}
            agentNames={agentNames}
            index={revisions.length - position}
            key={revision.id}
            onView={onView}
            revision={revision}
          />
        ))}
      </ul>
    </aside>
  );
}
