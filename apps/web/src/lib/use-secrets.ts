import { useCallback, useEffect, useState } from "react";
import type { Secret } from "./api";
import { useApi } from "./workspace-context";

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

export interface SecretsState {
  error: string | null;
  reload: () => Promise<void>;
  secrets: Secret[];
}

/**
 * The workspace's secrets, refetched after any mutation, like skills. Every row
 * carries its `agentIds`, so the agent picker's ticked boxes come from this one
 * list rather than from a second per-agent request.
 */
export const useSecrets = (enabled: boolean): SecretsState => {
  const api = useApi();
  const [secrets, setSecrets] = useState<Secret[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) {
      return;
    }
    try {
      setSecrets(await api.listSecrets());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause, "Failed to load secrets."));
    }
  }, [api, enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { error, reload, secrets };
};
