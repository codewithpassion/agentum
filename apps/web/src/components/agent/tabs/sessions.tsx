import type { AgentTab } from "../agent-tabs.ts";

function SessionsPanel() {
  return <p className="text-muted-foreground text-sm">Sessions.</p>;
}

export const sessionsTab: AgentTab = {
  id: "sessions",
  label: "Sessions",
  Panel: SessionsPanel,
};
