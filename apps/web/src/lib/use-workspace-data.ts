import { useCallback, useEffect, useState } from "react";
import {
  type Agent,
  type CategoryView,
  type Channel,
  getMembership,
  listAgents,
  listCategories,
  listChannels,
  type Membership,
} from "./api";

export interface WorkspaceData {
  agents: Agent[];
  categories: CategoryView[];
  channels: Channel[];
  error: string | null;
  /** The caller's own membership - who "me" is, for `isSelf`. */
  membership: Membership | null;
  reload: () => Promise<void>;
}

/** Agents, channels and categories are small lists; refetched after any mutation. */
export const useWorkspaceData = (enabled: boolean): WorkspaceData => {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [categories, setCategories] = useState<CategoryView[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [nextAgents, nextChannels, nextCategories, nextMembership] =
        await Promise.all([
          listAgents(),
          listChannels(),
          listCategories(),
          getMembership(),
        ]);
      setAgents(nextAgents);
      setChannels(nextChannels);
      setCategories(nextCategories);
      setMembership(nextMembership);
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

  return { agents, categories, channels, error, membership, reload };
};
