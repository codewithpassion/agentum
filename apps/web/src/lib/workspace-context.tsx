import { useUser } from "@clerk/tanstack-react-start";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type Api,
  createApi,
  isNotFound,
  type Membership,
  type WorkspaceView,
} from "./api";

/**
 * The workspace in the route (`/w/$workspaceSlug/…`), and the API client bound
 * to it. Nothing reads an ambient "current workspace": a component either sits
 * under this provider and gets a client that can only address one tenant, or it
 * has no business fetching workspace data at all.
 */
export interface ActiveWorkspace {
  api: Api;
  /** The caller's own membership - null until the first fetch answers. */
  membership: Membership | null;
  /** Re-reads the workspace after a rename. */
  reload: () => Promise<void>;
  slug: string;
  /** Null while loading, and for a signed-out visitor. */
  workspace: WorkspaceView | null;
}

const WorkspaceContext = createContext<ActiveWorkspace | null>(null);

export const useActiveWorkspace = (): ActiveWorkspace => {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error("useActiveWorkspace must be used inside WorkspaceProvider");
  }
  return value;
};

/** The API client for the workspace in the route. */
export const useApi = (): Api => useActiveWorkspace().api;

/** The slug every in-app `Link` needs for its `$workspaceSlug` param. */
export const useWorkspaceSlug = (): string => useActiveWorkspace().slug;

/**
 * Mount this keyed by slug: switching workspaces must reset every piece of
 * state below it, not race a refetch against the previous tenant's lists.
 *
 * `onNotFound` is what a 404 means here - an unknown slug and a workspace the
 * caller does not belong to are the same answer, deliberately (see the plan's
 * authorization section), so the screen is the same too.
 */
export function WorkspaceProvider({
  children,
  notFound,
  slug,
}: {
  children: ReactNode;
  notFound: ReactNode;
  slug: string;
}) {
  const { isSignedIn } = useUser();
  const signedIn = isSignedIn === true;

  const api = useMemo(() => createApi(slug), [slug]);
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [membership, setMembership] = useState<Membership | null>(null);
  const [missing, setMissing] = useState(false);

  const reload = useCallback(async () => {
    if (!signedIn) {
      return;
    }
    try {
      const data = await api.getWorkspace();
      setWorkspace(data.workspace);
      setMembership(data.membership);
      setMissing(false);
    } catch (cause) {
      if (isNotFound(cause)) {
        setMissing(true);
      }
    }
  }, [api, signedIn]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Remembered for `/`, which sends you back where you were.
  useEffect(() => {
    if (workspace) {
      window.localStorage.setItem("workspace", workspace.slug);
    }
  }, [workspace]);

  const value = useMemo<ActiveWorkspace>(
    () => ({ api, membership, reload, slug, workspace }),
    [api, membership, reload, slug, workspace]
  );

  // A 404 replaces the screen but keeps the provider, so the "not found" state
  // can still use the client (and the switcher) to get you somewhere real.
  const shown = missing ? notFound : children;

  return (
    <WorkspaceContext.Provider value={value}>{shown}</WorkspaceContext.Provider>
  );
}

/** Where `/` sends a visitor who has been here before. */
export const lastVisitedWorkspace = (): string | null =>
  window.localStorage.getItem("workspace");
