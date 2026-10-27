import {
  Bot,
  CalendarClock,
  Component,
  FolderOpen,
  Inbox,
  LayoutDashboard,
  type LucideIcon,
  Map as MapIcon,
  MessageCircleQuestion,
  MessagesSquare,
  ScrollText,
  Server,
  Settings,
  Sparkles,
  Webhook,
} from "lucide-react";

export interface NavItem {
  icon: LucideIcon;
  id: string;
  label: string;
  to: string;
}

/** Work first. Desk is the landing page. */
export const mainNavItems: readonly NavItem[] = [
  { icon: LayoutDashboard, id: "desk", label: "Desk", to: "/desk" },
  { icon: Bot, id: "agents", label: "Agents", to: "/agents" },
  { icon: MapIcon, id: "map", label: "Map", to: "/map" },
  {
    icon: MessageCircleQuestion,
    id: "qa",
    label: "Q&A",
    to: "/qa",
  },
  { icon: FolderOpen, id: "library", label: "Library", to: "/library" },
  { icon: Component, id: "artifacts", label: "Artifacts", to: "/artifacts" },
  { icon: Sparkles, id: "skills", label: "Skills", to: "/skills" },
  // `/machines` redirects to `/settings/machines`, so this item never shows
  // active on the settings page. Fine until V6.
  { icon: Server, id: "machines", label: "Machines", to: "/machines" },
];

/** Collapsed "More" group, until V3 and V7 absorb these. */
export const moreNavItems: readonly NavItem[] = [
  { icon: Inbox, id: "inbox", label: "Inbox", to: "/inbox" },
  {
    icon: MessagesSquare,
    id: "sessions",
    label: "Sessions",
    to: "/sessions",
  },
  { icon: ScrollText, id: "log", label: "Log", to: "/log" },
  {
    icon: CalendarClock,
    id: "routines",
    label: "Routines",
    to: "/routines",
  },
  { icon: Webhook, id: "triggers", label: "Triggers", to: "/triggers" },
];

export const settingsNavItem: NavItem = {
  icon: Settings,
  id: "settings",
  label: "Settings",
  to: "/settings",
};
