import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar";
import { KIND_ICONS } from "../list/kind-icons.ts";
import { type PinnedArtifact, pinnedHref, sortPinned } from "./pinned-logic.ts";

/** The "Pinned" group of the sidebar. It renders nothing without pins. */
export function PinnedSidebarGroup({
  onNavigate,
  pins,
}: {
  onNavigate?: () => void;
  pins: readonly PinnedArtifact[];
}) {
  if (pins.length === 0) {
    return null;
  }
  return (
    <SidebarGroup data-testid="pinned-sidebar">
      <SidebarGroupLabel>Pinned</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {sortPinned(pins).map((pin) => {
            const Icon = KIND_ICONS[pin.kind];
            return (
              <SidebarMenuItem key={pin.artifactId}>
                <SidebarMenuButton asChild>
                  <a href={pinnedHref(pin)} onClick={onNavigate}>
                    <Icon />
                    <span>{pin.title}</span>
                  </a>
                </SidebarMenuButton>
              </SidebarMenuItem>
            );
          })}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
