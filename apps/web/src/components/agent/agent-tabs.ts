import type { ReactNode } from "react";
import type { AgentRecord } from "#/integrations/trpc/types";
import { chatTab } from "./tabs/chat.tsx";
import { connectorsTab } from "./tabs/connectors.tsx";
import { sessionsTab } from "./tabs/sessions.tsx";
import { settingsTab } from "./tabs/settings.tsx";
import { skillsTab } from "./tabs/skills.tsx";
import { slackTab } from "./tabs/slack.tsx";
import { triggersTab } from "./tabs/triggers.tsx";

/** What the agent page hands every tab. */
export interface AgentTabProps {
  agent: AgentRecord;
  /** Opens a session in the chat tab, or a new chat when `sessionId` is undefined. */
  openSession: (sessionId: string | undefined) => void;
  /** The session the chat tab shows, from the `session` search param. */
  sessionId: string | undefined;
}

export interface AgentTab {
  id: string;
  label: string;
  Panel: (props: AgentTabProps) => ReactNode;
}

export const agentTabs: readonly AgentTab[] = [
  chatTab,
  sessionsTab,
  settingsTab,
  connectorsTab,
  skillsTab,
  slackTab,
  triggersTab,
];
