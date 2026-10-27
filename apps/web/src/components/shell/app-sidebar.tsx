import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "#/components/ui/sidebar";
import { agentInitials, agentTileColour } from "./agent-tile.ts";
import {
  mainNavItems,
  moreNavItems,
  type NavItem,
  settingsNavItem,
} from "./nav-registry.ts";

export interface SidebarAgent {
  id: string;
  name: string;
}

interface AppSidebarProps {
  agents: readonly SidebarAgent[];
  /** Tasks waiting on the user. */
  needsYouCount: number;
  /** Open Q&A questions. */
  openQaCount: number;
}

function isActive(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

/** Click handler that closes the mobile nav sheet after a link is tapped. */
function useCloseMobileNav() {
  const { setOpenMobile } = useSidebar();
  return () => setOpenMobile(false);
}

function NavMenuItem({
  badge,
  badgeLabel = "need you",
  item,
  pathname,
}: {
  badge?: number;
  badgeLabel?: string;
  item: NavItem;
  pathname: string;
}) {
  const closeMobileNav = useCloseMobileNav();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive(pathname, item.to)}>
        <Link onClick={closeMobileNav} to={item.to}>
          <item.icon />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
      {badge === undefined ? null : (
        <SidebarMenuBadge aria-label={`${badge} ${badgeLabel}`}>
          {badge}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

function AgentsSection({
  agents,
  pathname,
}: {
  agents: readonly SidebarAgent[];
  pathname: string;
}) {
  const closeMobileNav = useCloseMobileNav();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Agents</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {agents.map((agent) => (
            <SidebarMenuItem key={agent.id}>
              <SidebarMenuButton
                asChild
                isActive={isActive(pathname, `/agents/${agent.id}`)}
              >
                <Link
                  onClick={closeMobileNav}
                  params={{ agentId: agent.id }}
                  to="/agents/$agentId"
                >
                  <span
                    aria-hidden="true"
                    className={`flex size-5 shrink-0 items-center justify-center rounded font-semibold text-[10px] text-white ${agentTileColour(agent.name)}`}
                  >
                    {agentInitials(agent.name)}
                  </span>
                  <span>{agent.name}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
          <SidebarMenuItem>
            <SidebarMenuButton asChild>
              <Link onClick={closeMobileNav} to="/agents/new">
                <Plus />
                <span>New agent</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/** Badge count and label for a main nav item, or none. */
function mainNavBadge(
  item: NavItem,
  counts: { needsYou: number; openQa: number }
): { badge?: number; badgeLabel?: string } {
  if (item.id === "desk") {
    return { badge: counts.needsYou };
  }
  if (item.id === "qa") {
    return { badge: counts.openQa, badgeLabel: "open" };
  }
  return {};
}

function MoreSection({ pathname }: { pathname: string }) {
  return (
    <Collapsible className="group/collapsible">
      <SidebarGroup>
        <SidebarGroupLabel asChild>
          <CollapsibleTrigger>
            More
            <ChevronRight className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-90" />
          </CollapsibleTrigger>
        </SidebarGroupLabel>
        <CollapsibleContent>
          <SidebarGroupContent>
            <SidebarMenu>
              {moreNavItems.map((item) => (
                <NavMenuItem item={item} key={item.id} pathname={pathname} />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

export function AppSidebar({
  agents,
  needsYouCount,
  openQaCount,
}: AppSidebarProps) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const { isMobile } = useSidebar();

  return (
    <Sidebar className="top-(--app-header-h) h-[calc(100svh-var(--app-header-h))]">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNavItems.map((item) => (
                <NavMenuItem
                  {...mainNavBadge(item, {
                    needsYou: needsYouCount,
                    openQa: openQaCount,
                  })}
                  item={item}
                  key={item.id}
                  pathname={pathname}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {/* On a phone "More" sits above the agent list, so Inbox, Sessions and
            the rest are one tap away instead of below ten agents. */}
        {isMobile ? <MoreSection pathname={pathname} /> : null}
        <AgentsSection agents={agents} pathname={pathname} />
        {isMobile ? null : <MoreSection pathname={pathname} />}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <NavMenuItem item={settingsNavItem} pathname={pathname} />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
