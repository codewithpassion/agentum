import type { AgentTab } from "../agent-tabs.ts";

function SlackPanel() {
  return <p className="text-muted-foreground text-sm">Slack arrives in M5.</p>;
}

export const slackTab: AgentTab = {
  id: "slack",
  label: "Slack",
  Panel: SlackPanel,
};
