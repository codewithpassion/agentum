import { Link } from "@tanstack/react-router";
import {
  APP_HEADER_MENU_SLOT,
  HeaderActionsSlot,
} from "#/components/shell/header-menu-slot";
import { useIsAppShell } from "#/hooks/use-app-shell";
import { cn } from "#/lib/utils";
import ClerkHeader from "../integrations/clerk/header-user.tsx";
import ThemeToggle from "./theme-toggle";

export default function Header() {
  const inAppShell = useIsAppShell();

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-border border-b bg-background/90 px-4 backdrop-blur-lg md:h-(--app-header-h)",
        // Signed-in pages: the header spans the shell, so the right items
        // meet the page content's right padding.
        inAppShell && "sm:pr-6"
      )}
    >
      <nav
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 py-3 sm:py-4 md:h-full md:py-0",
          !inAppShell && "page-wrap"
        )}
      >
        {/* The app shell portals its menu button in here on phones, so the
            header is the only bar. Empty (and hidden) elsewhere. */}
        {inAppShell ? (
          <div className="empty:hidden md:hidden" id={APP_HEADER_MENU_SLOT} />
        ) : null}
        <h2 className="m-0 flex-shrink-0 text-base">
          <Link
            className="inline-flex items-center gap-2.5 font-display text-foreground text-xl no-underline"
            to="/"
          >
            <span className="h-2.5 w-2.5 rounded-full bg-primary" />
            Agentum
          </Link>
        </h2>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <HeaderActionsSlot inAppShell={inAppShell} />
          <ClerkHeader />

          <ThemeToggle />
        </div>
      </nav>
    </header>
  );
}
