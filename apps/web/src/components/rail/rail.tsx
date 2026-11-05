import { useOrganization } from "@clerk/tanstack-react-start";
import { useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { PinnedArtifact } from "#/components/artifacts/pinned/pinned-logic";
import { PinnedSidebarGroup } from "#/components/artifacts/pinned/pinned-sidebar";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import {
  HeaderActionsPortal,
  HeaderMenuButton,
} from "#/components/shell/header-menu-slot";
import { useTaskControl } from "#/components/task/task-control.ts";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  useSidebar,
} from "#/components/ui/sidebar";
import { useIsMobile } from "#/hooks/use-mobile";
import { getTrpc } from "#/integrations/trpc/client";
import { FindDialog } from "./find-dialog.tsx";
import { RailFooter } from "./rail-footer.tsx";
import { RailHeaderActions } from "./rail-header-actions.tsx";
import { RailLink } from "./rail-link.tsx";
import { NeedsYouRow, SetupRow } from "./rail-needs-you.tsx";
import { RailQuestions } from "./rail-questions.tsx";
import { ScopeToggle } from "./rail-scope-toggle.tsx";
import { WorkingList } from "./rail-working.tsx";
import { useRail, useRailScope } from "./use-rail.ts";
import { WorkspaceMenu } from "./workspace-menu.tsx";
import { isActiveAdmin } from "./workspace-menu-logic.ts";

const MEMBERS_POLL_MS = 5 * 60_000;

const SECTION_HEADING_CLASS =
  "flex justify-between px-2 pt-3 pb-1.5 font-medium text-muted-foreground text-[13px]";

/** The item the main pane has open, from `/desk?item=...`. */
function useOpenItemId(): string | null {
  const location = useRouterState({ select: (state) => state.location });
  const { item } = location.search as { item?: unknown };
  return location.pathname === "/desk" && typeof item === "string"
    ? item
    : null;
}

/** Ctrl+K or Cmd+K toggles Find from anywhere in the app. */
function useFindShortcut(toggle: () => void) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !(event.shiftKey || event.altKey || event.repeat) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggle]);
}

interface RailProps {
  agents: readonly { id: string; name: string }[];
  /** Artifacts the person pinned to the sidebar. */
  pinned?: readonly PinnedArtifact[];
}

/** The sidebar: what waits on you, what is running, and Find for the rest. */
export function Rail({ agents, pinned = [] }: RailProps) {
  const { setOpenMobile } = useSidebar();
  const isMobile = useIsMobile();
  const { organization } = useOrganization();
  const { data: mine } = usePolledQuery(
    () => getTrpc().workspaces.mine.query(),
    null,
    MEMBERS_POLL_MS
  );
  const admin = isActiveAdmin({
    activeOrgId: organization?.id ?? null,
    mine: mine ?? [],
  });
  const openId = useOpenItemId();
  const { scope: chosenScope, setScope } = useRailScope();
  const { data: members } = usePolledQuery(
    () => getTrpc().members.list.query(),
    null,
    MEMBERS_POLL_MS
  );
  // A one-person workspace has no toggle, so a stored Everyone must not stick.
  const scope = members?.length === 1 ? "mine" : chosenScope;
  const { error, fresh, needsYou, view } = useRail(scope, openId);
  const [findOpen, setFindOpen] = useState(false);

  const closeMobileNav = useCallback(
    () => setOpenMobile(false),
    [setOpenMobile]
  );
  const toggleFind = useCallback(() => {
    setOpenMobile(false);
    setFindOpen((was) => !was);
  }, [setOpenMobile]);
  const openFind = useCallback(() => {
    setOpenMobile(false);
    setFindOpen(true);
  }, [setOpenMobile]);
  useFindShortcut(toggleFind);

  const now = new Date();
  // A failed member lookup keeps the toggle: hiding it would hide Everyone.
  const showToggle = members === null || members.length > 1;
  const setup = view?.setup ?? [];
  const working = view?.working ?? [];
  const control = useTaskControl();
  const actionable = needsYou.filter(
    (item) => !item.cards.some((card) => card.id === control?.requestId)
  );
  const waiting = actionable.length + setup.length;
  const waitingLabel = view === null ? "" : String(waiting);

  return (
    <>
      <Sidebar className="top-(--app-header-h) h-[calc(100svh-var(--app-header-h))]">
        <SidebarHeader className="gap-2 p-3 pb-1">
          <WorkspaceMenu onNavigate={closeMobileNav} />
          {showToggle && scope !== null ? (
            <ScopeToggle
              counts={view?.counts ?? null}
              onSelect={setScope}
              scope={scope}
            />
          ) : null}
        </SidebarHeader>
        <SidebarContent className="gap-0 px-2 pb-2">
          {control ? (
            <RailLink
              className="mx-1 my-2 border border-info/40 border-l-[3px] border-l-info bg-info/10 p-2 text-info text-sm focus-visible:ring-2 focus-visible:ring-ring"
              href={`/tasks/${control.runId}#computer`}
              onNavigate={closeMobileNav}
            >
              <span className="block font-medium">You have control</span>
              <span className="text-xs">{control.agentName}'s computer</span>
            </RailLink>
          ) : null}
          <h2 className={SECTION_HEADING_CLASS}>
            Needs you
            <span>{waitingLabel}</span>
          </h2>
          <div className="flex flex-col gap-1.5">
            {setup.map((step) => (
              <SetupRow key={step} onNavigate={closeMobileNav} step={step} />
            ))}
            {actionable.map((item) => (
              <NeedsYouRow
                fresh={fresh.has(item.id)}
                item={item}
                key={item.id}
                now={now}
                onNavigate={closeMobileNav}
                open={item.id === openId}
                scope={scope ?? "mine"}
              />
            ))}
            {view !== null && waiting === 0 ? (
              <p className="px-2 py-1 text-muted-foreground text-sm">
                Nothing needs you.
              </p>
            ) : null}
            {view === null && error === null ? (
              <p className="px-2 py-1 text-muted-foreground text-sm">Loading</p>
            ) : null}
            {view === null && error !== null ? (
              <p className="px-2 py-1 text-destructive text-sm" role="alert">
                Could not load your list.
              </p>
            ) : null}
          </div>
          {view === null ? null : (
            <RailLink
              className="mt-2 flex min-h-10 items-center rounded-md px-2 text-muted-foreground text-sm no-underline hover:text-foreground md:min-h-8"
              href="/desk?view=board"
              onNavigate={closeMobileNav}
            >
              {view.doneToday} done today
            </RailLink>
          )}
          <RailLink
            className="mt-2 flex min-h-10 items-center rounded-md px-2 text-sm hover:bg-muted"
            href="/assistant"
            onNavigate={closeMobileNav}
          >
            Assistant
          </RailLink>
          <RailQuestions onNavigate={closeMobileNav} />
          <PinnedSidebarGroup onNavigate={closeMobileNav} pins={pinned} />
        </SidebarContent>
        <WorkingList onNavigate={closeMobileNav} runs={working} />
        <RailFooter
          admin={admin}
          isMobile={isMobile}
          onNavigate={closeMobileNav}
          onOpenFind={openFind}
        />
      </Sidebar>
      <HeaderMenuButton count={waiting} />
      <HeaderActionsPortal>
        <RailHeaderActions
          agents={agents}
          onNavigate={closeMobileNav}
          onOpenFind={openFind}
        />
      </HeaderActionsPortal>
      <FindDialog agents={agents} onOpenChange={setFindOpen} open={findOpen} />
    </>
  );
}
