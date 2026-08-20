import type { Connector } from "#/modules/connectors/schema";
import {
  connectorServerName,
  isConnectorUsable,
  MAX_AGENT_CONNECTORS,
} from "#/modules/connectors/usability";
import type { ConnectorServer } from "./gateway";

/**
 * An agent's connectors, reduced to what the two API calls that carry them
 * need: the servers declared on the agent, and the vaults attached to its next
 * session. Pure, so the whole composition is testable without a client.
 */

export interface ComposedConnectors {
  /** Over the cap, so attached to nothing - reported on the agent's sync. */
  dropped: Connector[];
  servers: ConnectorServer[];
  /** `vault_ids` for session create: the attached servers' vaults, deduped. */
  vaultIds: string[];
}

export const composeAgentConnectors = (
  connectors: readonly Connector[]
): ComposedConnectors => {
  const usable = connectors.filter(isConnectorUsable);
  // Clamping is the backstop; assignment refuses to go past the cap in the
  // first place. Rows already over it (imported, or made usable in bulk) must
  // still produce a payload the API will accept.
  const attached = usable.slice(0, MAX_AGENT_CONNECTORS);

  return {
    dropped: usable.slice(MAX_AGENT_CONNECTORS),
    servers: attached.map((connector) => ({
      name: connectorServerName(connector),
      url: connector.url,
    })),
    vaultIds: [
      ...new Set(
        attached.flatMap((connector) =>
          connector.vaultId ? [connector.vaultId] : []
        )
      ),
    ],
  };
};
