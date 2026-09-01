import { useCallback, useEffect, useState } from "react";
import type { ComputerHost } from "./api";
import { useApi } from "./workspace-context";

/**
 * The workspace's computer hosts. There are a handful at most - one per Fly app
 * or per container somebody runs - so the list is refetched after any mutation
 * rather than patched, exactly like the connectors directory.
 */

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

export interface ComputerHostsState {
  error: string | null;
  hosts: ComputerHost[];
  reload: () => Promise<void>;
}

export const useComputerHosts = (enabled: boolean): ComputerHostsState => {
  const api = useApi();
  const [hosts, setHosts] = useState<ComputerHost[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) {
      return;
    }
    try {
      setHosts(await api.listComputerHosts());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause, "Failed to load computer hosts."));
    }
  }, [api, enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { error, hosts, reload };
};
