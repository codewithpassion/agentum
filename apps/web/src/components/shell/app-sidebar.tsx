import { Link, useRouterState } from "@tanstack/react-router";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar";
import { type NavItem, navGroups, settingsNavItem } from "./nav-registry.ts";

function NavMenuItem({ item, pathname }: { item: NavItem; pathname: string }) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={pathname === item.to || pathname.startsWith(`${item.to}/`)}
      >
        <Link to={item.to}>
          <item.icon />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  return (
    <Sidebar className="top-(--app-header-h) h-[calc(100svh-var(--app-header-h))]">
      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.id}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <NavMenuItem item={item} key={item.id} pathname={pathname} />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <NavMenuItem item={settingsNavItem} pathname={pathname} />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
