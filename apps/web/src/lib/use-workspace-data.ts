import { useCallback, useEffect, useState } from "react";
import { type Agent, type Channel, listAgents, listChannels } from "./api";

export interface WorkspaceData {
  agents: Agent[];
  channels: Channel[];
  error: string | null;
  reload: () => Promise<void>;
}

/** Agents and channels are small lists; they are refetched after any mutation. */
export const useWorkspaceData = (enabled: boolean): WorkspaceData => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [nextAgents, nextChannels] = await Promise.all([
        listAgents(),
        listChannels(),
      ]);
      setAgents(nextAgents);
      setChannels(nextChannels);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      reload();
    }
  }, [enabled, reload]);

  return { agents, channels, error, reload };
};
