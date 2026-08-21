import { cx } from "#/lib/cx";

/**
 * How many questions an agent (or the whole workspace) is waiting on.
 *
 * A badge is a button wherever there is somewhere to go: clicking it opens the
 * oldest question still waiting, which is the one that has been holding an
 * agent up the longest. Zero renders nothing at all - an empty badge is noise.
 */
export function PendingBadge({
  count,
  label,
  onClick,
}: {
  count: number;
  /** What a screen reader hears, e.g. "Ada is waiting on 2 answers". */
  label: string;
  onClick?: () => void;
}) {
  if (count <= 0) {
    return null;
  }

  const className = cx(
    "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--ws-warn)] px-1 font-semibold text-[10px] text-[var(--ws-bg)] leading-none",
    onClick && "ws-focus hover:brightness-110"
  );

  if (!onClick) {
    return (
      <span className={className} title={label}>
        <span className="sr-only">{label}</span>
        <span aria-hidden="true">{count}</span>
      </span>
    );
  }

  return (
    <button
      aria-label={label}
      className={className}
      data-testid="pending-questions-badge"
      onClick={onClick}
      title={label}
      type="button"
    >
      {count}
    </button>
  );
}

/** "2 answers" / "1 answer", for the badge's accessible name. */
export const pendingLabel = (count: number, subject: string): string =>
  `${subject} waiting on ${count} ${count === 1 ? "answer" : "answers"}`;
