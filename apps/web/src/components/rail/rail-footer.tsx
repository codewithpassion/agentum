import { useRouterState } from "@tanstack/react-router";
import { Bot, Folder, LayoutGrid, Search, Settings } from "lucide-react";
import { SidebarFooter } from "#/components/ui/sidebar";
import { cn } from "#/lib/utils";
import { RailLink } from "./rail-link.tsx";

export const settingsHref = (isMobile: boolean) =>
  isMobile ? "/settings" : "/settings/model-providers";

export function footerCurrent(location: { pathname: string; search: unknown }) {
  const path = location.pathname;
  if (path === "/agents" || path.startsWith("/agents/")) {
    return "Agents";
  }
  if (path === "/library" || path.startsWith("/library/")) {
    return "Files";
  }
  if (path === "/settings" || path.startsWith("/settings/")) {
    return "Settings";
  }
  if (
    path === "/artifacts" &&
    (location.search as { kind?: unknown }).kind === "app"
  ) {
    return "Apps";
  }
  return null;
}

export function RailFooter({
  admin,
  isMobile,
  onNavigate,
  onOpenFind,
}: {
  admin: boolean;
  isMobile: boolean;
  onNavigate: () => void;
  onOpenFind: () => void;
}) {
  const current = useRouterState({
    select: (state) => footerCurrent(state.location),
  });
  const tabs = [
    { href: "/agents", icon: Bot, label: "Agents" },
    { href: "/artifacts?kind=app", icon: LayoutGrid, label: "Apps" },
    { href: "/library", icon: Folder, label: "Files" },
    ...(admin
      ? [{ href: settingsHref(isMobile), icon: Settings, label: "Settings" }]
      : []),
  ];
  return (
    <SidebarFooter className="gap-0 p-0 pb-[max(4px,env(safe-area-inset-bottom))]">
      {isMobile ? (
        <button
          className="mx-2 my-1.5 flex min-h-11 items-center gap-2 rounded-md bg-muted px-3 text-left font-medium text-muted-foreground text-sm hover:text-sidebar-foreground"
          onClick={onOpenFind}
          type="button"
        >
          <Search className="size-4" />
          Find
        </button>
      ) : null}
      <nav
        aria-label="Rail"
        className={cn(
          "grid border-sidebar-border border-t px-1",
          admin ? "grid-cols-4" : "grid-cols-3"
        )}
      >
        {tabs.map(({ label, href, icon: Icon }) => (
          <RailLink
            className={cn(
              "flex min-h-12 flex-col items-center justify-center gap-1 border-transparent border-t-2 font-medium text-[13px] text-muted-foreground no-underline hover:bg-sidebar-accent hover:text-sidebar-foreground",
              current === label &&
                "border-t-(--df-electric-cyan) bg-sidebar-accent text-sidebar-foreground"
            )}
            current={current === label}
            href={href}
            key={label}
            onNavigate={onNavigate}
          >
            <Icon className="size-[18px]" />
            {label}
          </RailLink>
        ))}
      </nav>
    </SidebarFooter>
  );
}
