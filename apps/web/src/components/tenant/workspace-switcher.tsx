import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Dialog } from "#/components/ui/dialog";
import { Popover } from "#/components/ui/popover";
import { useWorkspaces } from "#/lib/use-workspaces";
import { useActiveWorkspace } from "#/lib/workspace-context";
import { CreateWorkspaceForm } from "./create-workspace-form";

const ITEM_CLASS =
  "ws-focus flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--ws-text)] text-sm no-underline hover:bg-[var(--ws-surface-hover)]";

function WorkspaceOption({
  active,
  name,
  onSelect,
  role,
  slug,
}: {
  active: boolean;
  name: string;
  onSelect: (slug: string) => void;
  role: string;
  slug: string;
}) {
  const select = useCallback(() => onSelect(slug), [onSelect, slug]);

  return (
    <button className={ITEM_CLASS} onClick={select} type="button">
      <span className="w-3 shrink-0 text-[var(--ws-accent)]">
        {active ? "✓" : ""}
      </span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      <span className="shrink-0 text-[var(--ws-muted)] text-xs">{role}</span>
    </button>
  );
}

/**
 * Which workspace you are in, and how to leave for another. Switching drops the
 * search params on purpose: a channel or agent id from one workspace names
 * nothing in the next.
 */
export function WorkspaceSwitcher() {
  const { slug, workspace } = useActiveWorkspace();
  // The slug stands in until the workspace itself has been read.
  const title = workspace === null ? slug : workspace.name;
  const { workspaces } = useWorkspaces(true);
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const toggle = useCallback(() => setOpen((current) => !current), []);
  const close = useCallback(() => setOpen(false), []);
  const startCreate = useCallback(() => {
    setOpen(false);
    setCreating(true);
  }, []);
  const cancelCreate = useCallback(() => setCreating(false), []);

  const onCreated = useCallback(
    async (created: string) => {
      setCreating(false);
      await navigate({
        params: { workspaceSlug: created },
        search: {},
        to: "/w/$workspaceSlug",
      });
    },
    [navigate]
  );

  const switchTo = useCallback(
    (next: string) => {
      setOpen(false);
      navigate({
        params: { workspaceSlug: next },
        search: {},
        to: "/w/$workspaceSlug",
      });
    },
    [navigate]
  );

  return (
    <div className="relative min-w-0">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="ws-focus flex min-w-0 items-center gap-1.5 rounded-lg px-1.5 py-1 font-semibold text-sm hover:bg-[var(--ws-surface-hover)]"
        onClick={toggle}
        type="button"
      >
        <span className="truncate">{title}</span>
        <span aria-hidden="true" className="text-[10px] text-[var(--ws-muted)]">
          ▾
        </span>
      </button>

      <Popover className="w-60" onClose={close} open={open}>
        <p className="m-0 px-2.5 pt-1 pb-1.5 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
          Workspaces
        </p>
        {workspaces.map((entry) => (
          <WorkspaceOption
            active={entry.workspace.slug === slug}
            key={entry.workspace.slug}
            name={entry.workspace.name}
            onSelect={switchTo}
            role={entry.membership.role}
            slug={entry.workspace.slug}
          />
        ))}

        <div className="my-1 border-[var(--ws-line)] border-t" />

        <Link
          className={ITEM_CLASS}
          onClick={close}
          params={{ workspaceSlug: slug }}
          to="/w/$workspaceSlug/settings/members"
        >
          Workspace settings
        </Link>
        <button className={ITEM_CLASS} onClick={startCreate} type="button">
          Create workspace…
        </button>
      </Popover>

      <Dialog onClose={cancelCreate} open={creating} title="Create a workspace">
        <CreateWorkspaceForm onCreated={onCreated} />
      </Dialog>
    </div>
  );
}
