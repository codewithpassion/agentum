import {
  Bot,
  CalendarClock,
  Component,
  FolderOpen,
  Inbox,
  Kanban,
  ListChecks,
  type LucideIcon,
  Map as MapIcon,
  MessageCircleQuestion,
  Plus,
  ScrollText,
  Server,
  Settings,
  Sparkles,
  Webhook,
} from "lucide-react";
import { ENROLL_BUTTON_LABEL } from "#/components/machines/machine-logic.ts";
import { settingsNav } from "#/components/settings/settings-nav.ts";

export interface FindEntry {
  group: string;
  hint?: string;
  icon: LucideIcon;
  label: string;
  to: string;
}

const settingsHints: Readonly<Record<string, string>> = {
  "/settings/agent-connections": "Other agents",
  "/settings/connectors": "Apps",
  "/settings/model-providers": "AI account",
  "/settings/secrets": "Passwords and keys",
};

/** Listed under "What agents use" as Enrol a machine, so not repeated here. */
const LISTED_ELSEWHERE = new Set(["/settings/machines"]);

const settingsEntries: readonly FindEntry[] = settingsNav.flatMap((group) =>
  group.items
    .filter((item) => !LISTED_ELSEWHERE.has(item.to))
    .map((item) => ({
      group: "Settings",
      hint: settingsHints[item.to],
      icon: Settings,
      label: item.label,
      to: item.to,
    }))
);

export const findEntries: readonly FindEntry[] = [
  { group: "Work", icon: Sparkles, label: "Assistant", to: "/assistant" },
  {
    group: "Work",
    hint: "Desk",
    icon: Kanban,
    label: "Board",
    to: "/desk?view=board",
  },
  {
    group: "Work",
    hint: "Sessions",
    icon: ListChecks,
    label: "Conversations",
    to: "/sessions",
  },
  { group: "Work", icon: ScrollText, label: "Log", to: "/log" },
  {
    group: "Work",
    hint: "Q&A",
    icon: MessageCircleQuestion,
    label: "Questions",
    to: "/qa",
  },
  { group: "Work", hint: "Inbox", icon: Inbox, label: "Threads", to: "/inbox" },
  { group: "How things start", icon: MapIcon, label: "Map", to: "/map" },
  {
    group: "How things start",
    hint: "Routines",
    icon: CalendarClock,
    label: "Schedules",
    to: "/routines",
  },
  {
    group: "How things start",
    hint: "Triggers",
    icon: Webhook,
    label: "Web triggers",
    to: "/triggers",
  },
  { group: "What agents use", icon: Sparkles, label: "Skills", to: "/skills" },
  {
    group: "What agents use",
    hint: "Library",
    icon: FolderOpen,
    label: "Files and wiki",
    to: "/library",
  },
  {
    group: "What agents use",
    hint: "Artifacts",
    icon: Component,
    label: "Things agents made",
    to: "/artifacts",
  },
  {
    group: "What agents use",
    hint: "Artifacts",
    icon: Component,
    label: "Apps",
    to: "/artifacts?kind=app",
  },
  {
    group: "What agents use",
    hint: "Machines and computers",
    icon: Server,
    label: ENROLL_BUTTON_LABEL,
    to: "/settings/machines",
  },
  { group: "Agents", icon: Bot, label: "Agents", to: "/agents" },
  { group: "Agents", icon: Plus, label: "New agent", to: "/agents/new" },
  ...settingsEntries,
];

export function agentFindEntries(
  agents: readonly { id: string; name: string }[]
): { id: string; label: string; to: string }[] {
  return agents.map((agent) => ({
    id: agent.id,
    label: agent.name,
    to: `/agents/${agent.id}`,
  }));
}

export function pathOf(to: string): string {
  const index = to.indexOf("?");
  return index === -1 ? to : to.slice(0, index);
}
