import type { AgentStatuses } from "#/lib/use-conversation";

/**
 * The typing-indicator row: who the router woke from this channel and what they
 * are doing, plus the notice that the channel's loop guard has closed. Both are
 * driven by the channel socket, so they appear without a refetch.
 */

const BUSY_LABELS = {
  error: "ran into a problem",
  queued: "is queued, waiting for a free session",
  working: "is typing…",
} as const;

type BusyStatus = keyof typeof BUSY_LABELS;

const isBusy = (status: string): status is BusyStatus => status in BUSY_LABELS;

export function AgentActivity({
  statuses,
  suppressed,
}: {
  statuses: AgentStatuses;
  suppressed: boolean;
}) {
  const busy = Object.values(statuses).filter((entry) => isBusy(entry.status));

  if (busy.length === 0 && !suppressed) {
    return null;
  }

  return (
    <div
      className="flex flex-col gap-1 px-4 pb-2 text-[var(--ws-muted)] text-xs"
      data-testid="agent-activity"
    >
      {busy.map((entry) => (
        <p className="m-0 flex items-center gap-2" key={entry.agentId}>
          <span
            aria-hidden="true"
            className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ws-accent)]"
          />
          <span>
            {entry.agentName}{" "}
            {isBusy(entry.status) ? BUSY_LABELS[entry.status] : ""}
          </span>
        </p>
      ))}
      {suppressed ? (
        <p className="m-0">
          Agents have been talking to each other for a while, so further replies
          are paused here until you post.
        </p>
      ) : null}
    </div>
  );
}
