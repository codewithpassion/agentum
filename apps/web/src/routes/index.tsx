import { useUser } from "@clerk/tanstack-react-start";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect } from "react";
import { CreateWorkspaceForm } from "#/components/tenant/create-workspace-form";
import { useWorkspaces } from "#/lib/use-workspaces";
import { lastVisitedWorkspace } from "#/lib/workspace-context";

/**
 * `/` names no workspace, so it is a doorway rather than a screen: it sends you
 * to the one you were last in, or to your first, or - if you belong to none -
 * offers to make one. The resolution is client-side because the "last one" is
 * in localStorage, which no server render can read.
 */
export const Route = createFileRoute("/")({ component: WorkspaceEntry });

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="ws-shell items-center justify-center">
      <div className="w-full max-w-sm space-y-4 px-6">{children}</div>
    </div>
  );
}

function WorkspaceEntry() {
  const { isSignedIn } = useUser();
  const signedIn = isSignedIn === true;
  const navigate = useNavigate();
  const { loading, workspaces } = useWorkspaces(signedIn);

  const goTo = useCallback(
    (slug: string) => {
      navigate({
        params: { workspaceSlug: slug },
        replace: true,
        search: {},
        to: "/w/$workspaceSlug",
      });
    },
    [navigate]
  );

  useEffect(() => {
    const [first] = workspaces;
    if (!first) {
      return;
    }
    const remembered = lastVisitedWorkspace();
    const match = workspaces.find(
      (entry) => entry.workspace.slug === remembered
    );
    goTo((match ?? first).workspace.slug);
  }, [goTo, workspaces]);

  if (isSignedIn === false) {
    return (
      <Shell>
        <div className="space-y-3 text-center">
          <h1 className="m-0 font-semibold text-xl">Agentum</h1>
          <p className="m-0 text-[var(--ws-muted)] text-sm">
            A workspace where you and your agents talk in channels, threads and
            DMs.
          </p>
          <a
            className="inline-block rounded-lg bg-[var(--ws-accent)] px-4 py-2 font-medium text-[var(--ws-accent-ink)] text-sm no-underline"
            href="/login"
          >
            Sign in
          </a>
        </div>
      </Shell>
    );
  }

  if (loading || workspaces.length > 0) {
    return (
      <Shell>
        <p className="m-0 text-center text-[var(--ws-muted)] text-sm">
          Opening your workspace…
        </p>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="space-y-1.5 text-center">
        <h1 className="m-0 font-semibold text-lg">Create a workspace</h1>
        <p className="m-0 text-[var(--ws-muted)] text-sm">
          A workspace holds your channels, agents and everything they make. You
          can invite people to it once it exists.
        </p>
      </div>
      <CreateWorkspaceForm autoFocus onCreated={goTo} />
    </Shell>
  );
}
