import { Link } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { useWorkspaces } from "#/lib/use-workspaces";
import { CreateWorkspaceForm } from "./create-workspace-form";

/**
 * What an unknown slug looks like - which is also what a workspace you are not
 * a member of looks like, deliberately: the API answers 404 to both so that no
 * URL can confirm a workspace exists.
 */
export function WorkspaceNotFound({ slug }: { slug: string }) {
  const { workspaces } = useWorkspaces(true);
  const [creating, setCreating] = useState(false);

  const startCreate = useCallback(() => setCreating(true), []);
  const cancelCreate = useCallback(() => setCreating(false), []);
  const onCreated = useCallback((created: string) => {
    // A full load, so the new workspace starts from a clean slate.
    window.location.assign(`/w/${created}`);
  }, []);

  return (
    <div className="ws-shell items-center justify-center">
      <div className="w-full max-w-sm space-y-4 px-6">
        <div className="space-y-1.5 text-center">
          <h1 className="m-0 font-semibold text-lg">Workspace not found</h1>
          <p className="m-0 text-[var(--ws-muted)] text-sm">
            <span className="font-mono">{slug}</span> does not exist, or you are
            not a member of it.
          </p>
        </div>

        {workspaces.length > 0 ? (
          <div className="space-y-1">
            <p className="m-0 px-1 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
              Your workspaces
            </p>
            {workspaces.map((entry) => (
              <Link
                className="ws-focus flex items-center justify-between gap-2 rounded-lg border border-[var(--ws-line)] px-3 py-2 text-[var(--ws-text)] text-sm no-underline hover:bg-[var(--ws-surface-hover)]"
                key={entry.workspace.slug}
                params={{ workspaceSlug: entry.workspace.slug }}
                to="/w/$workspaceSlug"
              >
                <span className="truncate">{entry.workspace.name}</span>
                <span className="text-[var(--ws-muted)] text-xs">
                  {entry.membership.role}
                </span>
              </Link>
            ))}
          </div>
        ) : null}

        <div className="text-center">
          <Button onClick={startCreate} variant="subtle">
            Create a workspace
          </Button>
        </div>
      </div>

      <Dialog onClose={cancelCreate} open={creating} title="Create a workspace">
        <CreateWorkspaceForm onCreated={onCreated} />
      </Dialog>
    </div>
  );
}
