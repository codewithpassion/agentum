import { useUser } from "@clerk/tanstack-react-start";
import { Link } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";
import { NEXT_SESSION_NOTE } from "#/components/connectors/connector-detail";
import { ConnectorStatusDot } from "#/components/connectors/connector-status";
import { assignConnectorToAgent, unassignConnectorFromAgent } from "#/lib/api";
import { useAgentConnectors, useConnectors } from "#/lib/use-connectors";
// Straight from the server's rule, so the cap indicator cannot drift from it.
import { MAX_AGENT_CONNECTORS } from "#/modules/connectors/usability";

/**
 * Which connectors this agent may use (plan 4d, "Assign to agent"). Ticking a
 * box writes straight through - there is no Save here, because the assignment
 * is the whole change and it is reversible with the same click.
 */

export function AgentConnectorsPicker({ agentId }: { agentId: string }) {
  const { isSignedIn } = useUser();
  const signedIn = isSignedIn === true;
  const { connectors, error: listError } = useConnectors(signedIn);
  const {
    connectors: assigned,
    error: assignedError,
    reload,
  } = useAgentConnectors(agentId, signedIn);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const assignedIds = useMemo(
    () => new Set(assigned.map((connector) => connector.id)),
    [assigned]
  );

  const toggle = useCallback(
    (connectorId: string, next: boolean) => {
      setBusyId(connectorId);
      setError(null);
      (async () => {
        try {
          if (next) {
            await assignConnectorToAgent(connectorId, agentId);
          } else {
            await unassignConnectorFromAgent(connectorId, agentId);
          }
          await reload();
        } catch (cause) {
          setError(
            cause instanceof Error ? cause.message : "That did not work."
          );
        } finally {
          setBusyId(null);
        }
      })();
    },
    [agentId, reload]
  );

  const onChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) =>
      toggle(event.target.value, event.target.checked),
    [toggle]
  );

  const shown = listError ?? assignedError ?? error;

  return (
    <div className="space-y-3">
      <p className="m-0 text-[var(--ws-muted)] text-xs" data-testid="cap-note">
        {assigned.length} of {MAX_AGENT_CONNECTORS} connectors, plus this
        workspace's own server.
      </p>

      {connectors.length === 0 ? (
        <p className="m-0 text-[var(--ws-muted)] text-xs">
          No connectors yet.{" "}
          <Link className="text-[var(--ws-accent)]" to="/connectors">
            Add one
          </Link>
          .
        </p>
      ) : (
        <ul className="m-0 list-none space-y-1 p-0">
          {connectors.map((connector) => {
            const checked = assignedIds.has(connector.id);
            return (
              <li key={connector.id}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] hover:bg-[var(--ws-surface)]">
                  <input
                    checked={checked}
                    // The cap is the server's rule; the UI only stops the
                    // click that would break it.
                    disabled={
                      busyId === connector.id ||
                      (!checked && assigned.length >= MAX_AGENT_CONNECTORS)
                    }
                    onChange={onChange}
                    type="checkbox"
                    value={connector.id}
                  />
                  <ConnectorStatusDot status={connector.status} />
                  <span className="truncate">{connector.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      <p className="m-0 text-[var(--ws-muted)] text-xs">{NEXT_SESSION_NOTE}</p>

      {shown ? (
        <p className="m-0 text-[var(--ws-danger)] text-xs">{shown}</p>
      ) : null}
    </div>
  );
}
