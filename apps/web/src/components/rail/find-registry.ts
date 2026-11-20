import {
  Bot,
  CalendarClock,
  Component,
  FolderOpen,
  Inbox,
  Kanban,
  LayoutGrid,
  ListChecks,
  type LucideIcon,
  Map as MapIcon,
  MessageCircleQuestion,
  Plus,
  ScrollText,
  Server,
  Settings,
  Sparkles,
  Users,
  Wallet,
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
  "/settings/connectors": "Connectors",
  "/settings/model-providers": "AI account",
  "/settings/secrets": "Secrets",
  "/settings/sign-ins": "Your logins",
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
  {
    group: "Work",
    hint: "Agents",
    icon: LayoutGrid,
    label: "Home",
    to: "/home",
  },
  { group: "Work", icon: Sparkles, label: "Assistant", to: "/assistant" },
  {
    group: "Work",
    hint: "Board",
    icon: Kanban,
    label: "Desk",
    to: "/desk?view=board",
  },
  {
    group: "Work",
    icon: ListChecks,
    label: "Conversations",
    to: "/sessions",
  },
  { group: "Work", icon: ScrollText, label: "Log", to: "/log" },
  {
    group: "Work",
    hint: "Cost and weekly limits",
    icon: Wallet,
    label: "Spend",
    to: "/spend",
  },
  {
    group: "Work",
    hint: "Questions",
    icon: MessageCircleQuestion,
    label: "Q&A",
    to: "/qa",
  },
  { group: "Work", hint: "Threads", icon: Inbox, label: "Inbox", to: "/inbox" },
  { group: "How things start", icon: MapIcon, label: "Map", to: "/map" },
  {
    group: "How things start",
    hint: "Schedules and triggers",
    icon: CalendarClock,
    label: "Jobs",
    to: "/jobs",
  },
  { group: "What agents use", icon: Sparkles, label: "Skills", to: "/skills" },
  {
    group: "What agents use",
    hint: "Files and wiki",
    icon: FolderOpen,
    label: "Library",
    to: "/library",
  },
  {
    group: "What agents use",
    hint: "Things agents made",
    icon: Component,
    label: "Artifacts",
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
  { group: "Teams", icon: Users, label: "Teams", to: "/teams" },
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

/** One Find entry per team, opening the team's page. */
export function teamFindEntries(
  teams: readonly { id: string; name: string }[]
): { id: string; label: string; to: string }[] {
  return teams.map((team) => ({
    id: team.id,
    label: team.name,
    to: `/teams/${team.id}`,
  }));
}

export function pathOf(to: string): string {
  const index = to.indexOf("?");
  return index === -1 ? to : to.slice(0, index);
}
