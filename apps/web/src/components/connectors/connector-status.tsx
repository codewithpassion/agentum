import type { Connector, ConnectorStatus } from "#/lib/api";
import { cx } from "#/lib/cx";

/**
 * One vocabulary for connector health, shared by the sidebar, the directory,
 * the detail view and the agent rail's chips. The palette is the agent rail's -
 * accent for "in hand", danger for "broken", muted for "not yet" - so a status
 * dot reads the same wherever it appears.
 */

const STATUS_COLORS: Record<ConnectorStatus, string> = {
  auth_error: "var(--ws-danger)",
  authorizing: "var(--ws-accent)",
  connected: "var(--ws-accent)",
  disabled: "var(--ws-muted)",
  unconfigured: "var(--ws-muted)",
};

export const CONNECTOR_STATUS_LABELS: Record<ConnectorStatus, string> = {
  auth_error: "authorization failed",
  authorizing: "authorizing…",
  connected: "connected",
  disabled: "disabled",
  unconfigured: "not configured",
};

export function ConnectorStatusDot({ status }: { status: ConnectorStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        status === "authorizing" && "animate-pulse"
      )}
      style={{ background: STATUS_COLORS[status] }}
    />
  );
}

/** The dot plus its word, for anywhere the status is the point of the row. */
export function ConnectorStatusLine({ connector }: { connector: Connector }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[var(--ws-muted)] text-xs"
      data-testid="connector-status"
    >
      <ConnectorStatusDot status={connector.status} />
      <span>{CONNECTOR_STATUS_LABELS[connector.status]}</span>
    </span>
  );
}
