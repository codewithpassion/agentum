import type { Connector } from "./schema";

/**
 * Which connectors reach an agent's sessions, and what each one is called
 * there. Pure: turning this into an Anthropic payload is
 * `modules/anthropic/agent-connectors.ts`.
 */

/**
 * An agent may declare 20 `mcp_servers`, and one of those is always the
 * workspace server - so 19 connectors is the ceiling.
 */
export const MAX_AGENT_CONNECTORS = 19;

/**
 * Derived from the id alone, so a rename cannot move it. The name is how an
 * already-registered agent refers to the server, and how a session error names
 * the one whose credentials failed - both would desync if it tracked the name.
 */
export const connectorServerName = (connector: Pick<Connector, "id">): string =>
  `connector_${connector.id.replaceAll("-", "")}`;

/**
 * Whether this connector is worth attaching to an agent.
 *
 * `auth_error` still attaches when a vault credential exists: the credential is
 * Anthropic's to refresh, it is retried on the next idle-to-running transition,
 * and a connector that authorized once may simply recover - the plan is
 * explicit that bad credentials must not block session creation. One that never
 * got a credential has nothing to retry, so it is left off.
 */
export const isConnectorUsable = (connector: Connector): boolean => {
  if (connector.status === "disabled" || connector.status === "unconfigured") {
    return false;
  }
  // `connected`, `auth_error` and `authorizing` are left. A re-authorization in
  // flight is deliberately still usable: the vault credential it will replace
  // is untouched until the callback lands, so sessions keep working - and an
  // agent must not rotate its token twice for one trip through the popup.
  if (connector.authKind === "none") {
    // No credential exists for these, so `auth_error` means the server itself
    // started refusing us: there is nothing for a session to retry with.
    return connector.status === "connected";
  }
  return connector.vaultCredentialId !== null;
};
