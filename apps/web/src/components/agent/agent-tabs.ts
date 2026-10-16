import type { ReactNode } from "react";
import { chatTab } from "./tabs/chat.tsx";
import { connectorsTab } from "./tabs/connectors.tsx";
import { slackTab } from "./tabs/slack.tsx";
import { triggersTab } from "./tabs/triggers.tsx";

export interface AgentTab {
  id: string;
  label: string;
  Panel: () => ReactNode;
}

export const agentTabs: readonly AgentTab[] = [
  chatTab,
  connectorsTab,
  slackTab,
  triggersTab,
];
