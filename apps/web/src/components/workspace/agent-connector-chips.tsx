import { Link } from "@tanstack/react-router";
import {
  CONNECTOR_STATUS_LABELS,
  ConnectorStatusDot,
} from "#/components/connectors/connector-status";
import { useAgentConnectors } from "#/lib/use-connectors";
import { useWorkspaceSlug } from "#/lib/workspace-context";

/**
 * Connector health where the agent is (plan 4d, last row): one chip per
 * connector assigned to it, each linking to the connector that would need
 * fixing if its dot has gone red.
 */
export function AgentConnectorChips({ agentId }: { agentId: string }) {
  const workspaceSlug = useWorkspaceSlug();

  const { connectors } = useAgentConnectors(agentId, true);

  return (
    <section className="space-y-2">
      <h3 className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
        Connectors
      </h3>
      {connectors.length === 0 ? (
        <p className="m-0 text-[var(--ws-muted)] text-xs">
          None assigned. Add one from Edit → Connectors.
        </p>
      ) : (
        <ul
          className="m-0 flex list-none flex-wrap gap-1.5 p-0"
          data-testid="agent-connector-chips"
        >
          {connectors.map((connector) => (
            <li key={connector.id}>
              <Link
                className="ws-focus inline-flex items-center gap-1.5 rounded-lg border border-[var(--ws-line)] px-2 py-1 text-[var(--ws-muted)] text-xs no-underline hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
                params={{ connectorId: connector.id, workspaceSlug }}
                title={`${connector.name} - ${CONNECTOR_STATUS_LABELS[connector.status]}`}
                to="/w/$workspaceSlug/connectors/$connectorId"
              >
                <ConnectorStatusDot status={connector.status} />
                <span className="truncate">{connector.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
