import { useRouter, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import type { PinnedArtifact } from "#/components/artifacts/pinned/pinned-logic";
import { FindDialog } from "#/components/rail/find-dialog.tsx";
import { NeedsYouDrawer } from "#/components/rail/needs-you-drawer.tsx";
import { useNeedsYou } from "#/components/rail/use-needs-you.ts";
import { WorkspaceMenu } from "#/components/rail/workspace-menu.tsx";
import ThemeToggle from "#/components/theme-toggle";
import ClerkHeader from "#/integrations/clerk/header-user";
import { AssistantButton } from "./assistant-button.tsx";
import { MenuAccount } from "./menu-account.tsx";
import { TopBar } from "./top-bar.tsx";
import { findShortcut, topBarCurrent } from "./top-bar-logic.ts";

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

/**
 * The one bar of the signed-in app, with what it opens: the Needs you drawer
 * and Find. The count and the shortcut live here, above the drawer, because
 * a closed drawer unmounts its content.
 */
export function AppTopBar({
  agents,
  pinned,
}: {
  agents: readonly { id: string; name: string }[];
  pinned: readonly PinnedArtifact[];
}) {
  const router = useRouter();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const needsYou = useNeedsYou();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shortcut, setShortcut] = useState("Ctrl K");
  useEffect(() => setShortcut(findShortcut(navigator.platform)), []);

  const toggleFind = useCallback(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
    setFindOpen((was) => !was);
  }, []);
  const openFind = useCallback(() => {
    setDrawerOpen(false);
    setMenuOpen(false);
    setFindOpen(true);
  }, []);
  const openNeedsYou = useCallback(() => {
    setMenuOpen(false);
    setDrawerOpen(true);
  }, []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  useFindShortcut(toggleFind);

  // Spend shows once its page exists, so SP.4 adds the route and nothing here.
  const hasSpendPage = Object.hasOwn(router.routesByPath, "/spend");

  return (
    <>
      <TopBar
        assistant={<AssistantButton onToggle={closeMenu} />}
        count={needsYou.count}
        current={topBarCurrent(pathname)}
        findShortcut={shortcut}
        hasSpendPage={hasSpendPage}
        menuAccount={<MenuAccount onNavigate={closeMenu} />}
        menuOpen={menuOpen}
        onMenuOpenChange={setMenuOpen}
        onOpenFind={openFind}
        onOpenNeedsYou={openNeedsYou}
        theme={<ThemeToggle />}
        user={<ClerkHeader />}
        workspace={<WorkspaceMenu onNavigate={closeMenu} />}
      />
      <NeedsYouDrawer
        onOpenChange={setDrawerOpen}
        open={drawerOpen}
        pinned={pinned}
        state={needsYou}
      />
      <FindDialog agents={agents} onOpenChange={setFindOpen} open={findOpen} />
    </>
  );
}
