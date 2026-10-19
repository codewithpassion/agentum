import {
  Bot,
  CalendarClock,
  FolderOpen,
  Inbox,
  type LucideIcon,
  MessagesSquare,
  ScrollText,
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

export interface NavGroup {
  id: string;
  items: readonly NavItem[];
  label: string;
}

export const navGroups: readonly NavGroup[] = [
  {
    id: "work",
    items: [
      { icon: Bot, id: "agents", label: "Agents", to: "/agents" },
      {
        icon: MessagesSquare,
        id: "sessions",
        label: "Sessions",
        to: "/sessions",
      },
      { icon: Inbox, id: "inbox", label: "Inbox", to: "/inbox" },
      { icon: ScrollText, id: "log", label: "Log", to: "/log" },
    ],
    label: "Work",
  },
  {
    id: "automation",
    items: [
      {
        icon: CalendarClock,
        id: "routines",
        label: "Routines",
        to: "/routines",
      },
      { icon: Webhook, id: "triggers", label: "Triggers", to: "/triggers" },
    ],
    label: "Automation",
  },
  {
    id: "knowledge",
    items: [
      { icon: FolderOpen, id: "library", label: "Library", to: "/library" },
      { icon: Sparkles, id: "skills", label: "Skills", to: "/skills" },
    ],
    label: "Knowledge",
  },
];

export const settingsNavItem: NavItem = {
  icon: Settings,
  id: "settings",
  label: "Settings",
  to: "/settings",
};
