import { useCallback, useEffect, useState } from "react";
import type { Connector, ConnectorAgentRef } from "./api";
import { useApi } from "./workspace-context";

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

export interface ConnectorsState {
  connectors: Connector[];
  error: string | null;
  reload: () => Promise<void>;
}

/** The directory is small and is refetched after any mutation, like the wiki. */
export const useConnectors = (enabled: boolean): ConnectorsState => {
  const api = useApi();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setConnectors(await api.listConnectors());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause, "Failed to load connectors."));
    }
  }, [api]);

  useEffect(() => {
    if (enabled) {
      reload();
    }
  }, [enabled, reload]);

  return { connectors, error, reload };
};

export interface ConnectorDetailState {
  agents: ConnectorAgentRef[];
  connector: Connector | null;
  error: string | null;
  loading: boolean;
  reload: () => Promise<void>;
  /** Applies a connector the caller already has, without a round trip. */
  setConnector: (connector: Connector) => void;
}

export const useConnectorDetail = (
  id: string | null,
  enabled: boolean
): ConnectorDetailState => {
  const api = useApi();
  const [connector, setConnector] = useState<Connector | null>(null);
  const [agents, setAgents] = useState<ConnectorAgentRef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!(enabled && id)) {
      return;
    }
    setLoading(true);
    try {
      const detail = await api.getConnector(id);
      setConnector(detail.connector);
      setAgents(detail.agents);
      setError(null);
    } catch (cause) {
      setConnector(null);
      setError(messageOf(cause, "Failed to load this connector."));
    } finally {
      setLoading(false);
    }
  }, [api, enabled, id]);

  // Switching connectors must not leave the previous one's agents on screen
  // while the next request is in flight.
  useEffect(() => {
    setAgents([]);
    setConnector(null);
    reload();
  }, [reload]);

  return { agents, connector, error, loading, reload, setConnector };
};

/** Which connectors reach this agent's sessions - the rail chips' source. */
export const useAgentConnectors = (
  agentId: string | null,
  enabled: boolean
): ConnectorsState => {
  const api = useApi();
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!(enabled && agentId)) {
      setConnectors([]);
      return;
    }
    try {
      setConnectors(await api.listAgentConnectors(agentId));
      setError(null);
    } catch (cause) {
      setError(messageOf(cause, "Failed to load this agent's connectors."));
    }
  }, [agentId, api, enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { connectors, error, reload };
};
