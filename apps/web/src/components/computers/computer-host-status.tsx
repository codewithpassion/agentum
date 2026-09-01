import type { ComputerHost, ComputerHostStatus } from "#/lib/api";
import { lastSeenLabel } from "#/lib/computer-hosts";

/**
 * One vocabulary for how a computer host stands, shared by the sidebar, the
 * list and the host's own page. The palette is the connectors' and the skills' -
 * accent for "answering", danger for "broken", muted for "not yet" - so a dot
 * reads the same wherever it appears.
 */

const STATUS_COLORS: Record<ComputerHostStatus, string> = {
  error: "var(--ws-danger)",
  offline: "var(--ws-muted)",
  ready: "var(--ws-accent)",
  unconfigured: "var(--ws-muted)",
};

export const COMPUTER_HOST_STATUS_LABELS: Record<ComputerHostStatus, string> = {
  error: "not reachable",
  offline: "offline",
  ready: "ready",
  unconfigured: "not connected yet",
};

export function ComputerHostStatusDot({
  status,
}: {
  status: ComputerHostStatus;
}) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
      style={{ background: STATUS_COLORS[status] }}
    />
  );
}

/** The dot, its word and when the daemon was last heard from. */
export function ComputerHostStatusLine({ host }: { host: ComputerHost }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[var(--ws-muted)] text-xs"
      data-testid="computer-host-status"
    >
      <ComputerHostStatusDot status={host.status} />
      <span>{COMPUTER_HOST_STATUS_LABELS[host.status]}</span>
      <span aria-hidden="true">·</span>
      <span>{lastSeenLabel(host.lastSeenAt)}</span>
    </span>
  );
}
