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
  /** Tasks waiting on the user. Reads 0 until V2.8 lands. */
  needsYouCount: number;
}

function isActive(pathname: string, to: string) {
  return pathname === to || pathname.startsWith(`${to}/`);
}

function NavMenuItem({
  badge,
  item,
  pathname,
}: {
  badge?: number;
  item: NavItem;
  pathname: string;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive(pathname, item.to)}>
        <Link to={item.to}>
          <item.icon />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
      {badge === undefined ? null : (
        <SidebarMenuBadge aria-label={`${badge} need you`}>
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
                <Link params={{ agentId: agent.id }} to="/agents/$agentId">
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
              <Link to="/agents/new">
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

export function AppSidebar({ agents, needsYouCount }: AppSidebarProps) {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <Sidebar className="top-(--app-header-h) h-[calc(100svh-var(--app-header-h))]">
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {mainNavItems.map((item) => (
                <NavMenuItem
                  badge={item.id === "desk" ? needsYouCount : undefined}
                  item={item}
                  key={item.id}
                  pathname={pathname}
                />
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <AgentsSection agents={agents} pathname={pathname} />
        <MoreSection pathname={pathname} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <NavMenuItem item={settingsNavItem} pathname={pathname} />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
