import {
  useClerk,
  useOrganization,
  useOrganizationList,
} from "@clerk/tanstack-react-start";
import { Check, ChevronsUpDown } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu";
import { getTrpc } from "#/integrations/trpc/client";
import { NewWorkspaceDialog } from "./new-workspace-dialog.tsx";
import { useSwitchWorkspace } from "./use-switch-workspace.ts";
import {
  canCreateWorkspace,
  type WorkspaceChoice,
  workspaceChoices,
} from "./workspace-menu-logic.ts";

const MINE_POLL_MS = 5 * 60_000;

function ChoiceItem({
  choice,
  onChoose,
}: {
  choice: WorkspaceChoice;
  onChoose: (organizationId: string) => void;
}) {
  const choose = useCallback(() => {
    if (!choice.current) {
      onChoose(choice.id);
    }
  }, [choice.current, choice.id, onChoose]);
  return (
    <DropdownMenuItem
      aria-current={choice.current ? "true" : undefined}
      className="items-start gap-2 whitespace-normal break-words"
      onSelect={choose}
    >
      <Check
        aria-hidden="true"
        className={
          choice.current ? "mt-0.5 shrink-0" : "mt-0.5 shrink-0 opacity-0"
        }
      />
      <span className="min-w-0">{choice.name}</span>
    </DropdownMenuItem>
  );
}

/**
 * The workspace name in the rail header, as a menu: the person's workspaces
 * with the current one marked, then Manage members and New workspace. Only
 * organisations that have a workspace row are listed, which is why this is
 * not Clerk's OrganizationSwitcher.
 */
export function WorkspaceMenu({ onNavigate }: { onNavigate: () => void }) {
  const clerk = useClerk();
  const { organization } = useOrganization();
  const { userMemberships } = useOrganizationList({
    userMemberships: { infinite: true, pageSize: 100 },
  });
  const { data: mine } = usePolledQuery(
    () => getTrpc().workspaces.mine.query(),
    null,
    MINE_POLL_MS
  );
  const { activate, error, switchTo } = useSwitchWorkspace();
  const [creating, setCreating] = useState(false);
  const activeOrgId = organization?.id ?? null;

  const choices = useMemo(
    () =>
      workspaceChoices({
        activeOrgId,
        mine: mine ?? [],
        orgs: (userMemberships.data ?? []).map((membership) => ({
          id: membership.organization.id,
          name: membership.organization.name,
        })),
      }),
    [activeOrgId, mine, userMemberships.data]
  );
  const canCreate = canCreateWorkspace({ activeOrgId, mine: mine ?? [] });

  // Below md the rail is a modal sheet, and its focus trap would block
  // Clerk's modal, so the sheet closes first.
  const openMembers = useCallback(() => {
    onNavigate();
    clerk.openOrganizationProfile();
  }, [clerk, onNavigate]);
  const openCreate = useCallback(() => setCreating(true), []);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex w-full items-start justify-between gap-2 rounded-md px-1 py-0.5 text-left font-heading text-lg hover:bg-muted"
            title={organization?.name}
            type="button"
          >
            <span className="min-w-0 break-words">
              {organization?.name ?? "Workspace"}
            </span>
            <ChevronsUpDown
              aria-hidden="true"
              className="mt-1.5 size-4 shrink-0 text-muted-foreground"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 max-w-[90vw]">
          {choices.map((choice) => (
            <ChoiceItem choice={choice} key={choice.id} onChoose={switchTo} />
          ))}
          {choices.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem onSelect={openMembers}>
            Manage members
          </DropdownMenuItem>
          {canCreate ? (
            <DropdownMenuItem onSelect={openCreate}>
              New workspace
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {error === null ? null : (
        <p className="px-1 text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <NewWorkspaceDialog
        onCreated={activate}
        onOpenChange={setCreating}
        open={creating}
      />
    </>
  );
}
