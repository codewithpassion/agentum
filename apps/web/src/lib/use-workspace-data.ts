import { useCallback, useEffect, useState } from "react";
import {
  type Agent,
  type CategoryView,
  type Channel,
  listAgents,
  listCategories,
  listChannels,
} from "./api";

export interface WorkspaceData {
  agents: Agent[];
  categories: CategoryView[];
  channels: Channel[];
  error: string | null;
  reload: () => Promise<void>;
}

/** Agents, channels and categories are small lists; refetched after any mutation. */
export const useWorkspaceData = (enabled: boolean): WorkspaceData => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [nextAgents, nextChannels, nextCategories] = await Promise.all([
        listAgents(),
        listChannels(),
        listCategories(),
      ]);
      setAgents(nextAgents);
      setChannels(nextChannels);
      setCategories(nextCategories);
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

  return { agents, categories, channels, error, reload };
};
