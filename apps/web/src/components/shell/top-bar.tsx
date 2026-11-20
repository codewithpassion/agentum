import {
  Bell,
  Folder,
  House,
  type LucideIcon,
  Menu,
  Plus,
  Search,
  Wallet,
} from "lucide-react";
import { type ReactNode, useCallback } from "react";
import { Button, buttonVariants } from "#/components/ui/button.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet.tsx";
import { cn } from "#/lib/utils.ts";
import { RailLink } from "../rail/rail-link.tsx";
import {
  NEW_AGENT_HREF,
  type TopBarLabel,
  topBarLinks,
} from "./top-bar-logic.ts";

const PAGE_ICONS: Record<TopBarLabel, LucideIcon> = {
  Files: Folder,
  Home: House,
  Spend: Wallet,
};

const ICON_CLASS = "size-4 shrink-0";

const newAgentClass = cn(
  buttonVariants({ variant: "outline" }),
  "no-underline"
);

const linkClass = (isCurrent: boolean): string =>
  cn(
    "inline-flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-muted-foreground text-sm no-underline transition-colors hover:text-foreground",
    isCurrent && "bg-muted text-foreground"
  );

function PageLinkContent({ label }: { label: TopBarLabel }) {
  const Icon = PAGE_ICONS[label];
  return (
    <>
      <Icon className={ICON_CLASS} />
      {label}
    </>
  );
}

function NeedsYouButton({
  count,
  onClick,
  showLabel,
}: {
  count: number | null;
  onClick: () => void;
  showLabel: boolean;
}) {
  const hasCount = count !== null && count > 0;
  return (
    <Button
      aria-label={hasCount ? `Needs you, ${count} waiting` : "Needs you"}
      onClick={onClick}
      type="button"
      variant="outline"
    >
      <Bell />
      {showLabel ? "Needs you" : null}
      {hasCount ? (
        <span className="rounded bg-primary px-1.5 font-bold text-[11px] text-primary-foreground">
          {count}
        </span>
      ) : null}
    </Button>
  );
}

interface TopBarProps {
  assistant: ReactNode;
  /** Needs you count. Null until loaded. */
  count: number | null;
  current: TopBarLabel | null;
  findShortcut: string;
  hasSpendPage: boolean;
  /** The account rows of the phone menu, in place of `user`. */
  menuAccount: ReactNode;
  /** The phone menu sheet, open or not. The caller owns it so Find and Needs you can close it. */
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onOpenFind: () => void;
  onOpenNeedsYou: () => void;
  theme: ReactNode;
  user: ReactNode;
  workspace: ReactNode;
}

/** The app's one top bar: pages, Find, Needs you and account controls. */
export function TopBar({
  assistant,
  count,
  current,
  findShortcut,
  hasSpendPage,
  menuAccount,
  menuOpen,
  onMenuOpenChange,
  onOpenFind,
  onOpenNeedsYou,
  theme,
  user,
  workspace,
}: TopBarProps) {
  const openMenu = useCallback(
    () => onMenuOpenChange(true),
    [onMenuOpenChange]
  );
  const closeMenu = useCallback(
    () => onMenuOpenChange(false),
    [onMenuOpenChange]
  );

  const links = topBarLinks(hasSpendPage);
  const homeLinks = links.filter((link) => link.label === "Home");
  const linksExceptHome = links.filter((link) => link.label !== "Home");

  return (
    <header className="sticky top-0 z-50 flex h-14 shrink-0 items-center gap-2 border-border border-b bg-background/90 px-3 backdrop-blur-lg sm:px-4 lg:h-(--app-header-h)">
      <nav aria-label="Main" className="flex min-w-0 flex-1 items-center">
        <div className="flex min-w-0 flex-1 items-center gap-2 max-lg:hidden">
          <div className="w-48 shrink-0">{workspace}</div>
          {links.map((link) => (
            <RailLink
              className={linkClass(link.label === current)}
              current={link.label === current}
              href={link.href}
              key={link.href}
            >
              <PageLinkContent label={link.label} />
            </RailLink>
          ))}
          <Button
            aria-label="Find"
            onClick={onOpenFind}
            type="button"
            variant="ghost"
          >
            <Search />
            Find
            <kbd className="rounded border border-border px-1 text-[11px] text-muted-foreground max-xl:hidden">
              {findShortcut}
            </kbd>
          </Button>
          <span aria-hidden className="ml-auto" />
          {assistant}
          <NeedsYouButton count={count} onClick={onOpenNeedsYou} showLabel />
          <RailLink className={newAgentClass} href={NEW_AGENT_HREF}>
            <Plus />
            New agent
          </RailLink>
          {theme}
          {user}
        </div>

        <div className="flex min-w-0 flex-1 items-center gap-2 lg:hidden">
          {homeLinks.map((link) => (
            <RailLink
              className={cn(linkClass(link.label === current), "min-h-10")}
              current={link.label === current}
              href={link.href}
              key={link.href}
            >
              <PageLinkContent label={link.label} />
            </RailLink>
          ))}
          <span aria-hidden className="ml-auto" />
          <NeedsYouButton
            count={count}
            onClick={onOpenNeedsYou}
            showLabel={false}
          />
          <Button
            aria-label="Menu"
            className="size-10"
            onClick={openMenu}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Menu />
          </Button>
          <Sheet onOpenChange={onMenuOpenChange} open={menuOpen}>
            <SheetContent className="w-full gap-0 p-0 sm:max-w-sm" side="right">
              <SheetHeader className="border-border border-b pr-12">
                <SheetTitle>Menu</SheetTitle>
                <SheetDescription className="sr-only">
                  Pages, Find and your account
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-1 p-4">
                <div className="flex min-h-11 items-center">{workspace}</div>
                <Button
                  className="min-h-11 justify-start"
                  onClick={onOpenFind}
                  type="button"
                  variant="ghost"
                >
                  <Search />
                  Find
                </Button>
                {linksExceptHome.map((link) => (
                  <RailLink
                    className={cn(
                      linkClass(link.label === current),
                      "min-h-11"
                    )}
                    current={link.label === current}
                    href={link.href}
                    key={link.href}
                    onNavigate={closeMenu}
                  >
                    <PageLinkContent label={link.label} />
                  </RailLink>
                ))}
                <RailLink
                  className={cn(newAgentClass, "min-h-11")}
                  href={NEW_AGENT_HREF}
                  onNavigate={closeMenu}
                >
                  <Plus />
                  New agent
                </RailLink>
                <div className="flex min-h-11 items-center">{assistant}</div>
                <div className="flex min-h-11 items-center gap-2">{theme}</div>
                {menuAccount}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </nav>
    </header>
  );
}
