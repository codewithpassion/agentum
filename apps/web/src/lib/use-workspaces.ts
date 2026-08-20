import { useCallback, useEffect, useState } from "react";
import { listWorkspaces, type WorkspaceMembership } from "./api";

export interface WorkspacesState {
  error: string | null;
  /** False once the first answer is in, whichever way it went. */
  loading: boolean;
  reload: () => Promise<void>;
  workspaces: WorkspaceMembership[];
}

/**
 * Every workspace the caller belongs to. This is the one list that is *not*
 * scoped to a workspace, which is why the switcher can still be rendered on the
 * "workspace not found" screen.
 */
export const useWorkspaces = (enabled: boolean): WorkspacesState => {
  const [workspaces, setWorkspaces] = useState<WorkspaceMembership[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!enabled) {
      return;
    }
    try {
      setWorkspaces(await listWorkspaces());
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to load workspaces."
      );
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { error, loading, reload, workspaces };
};
