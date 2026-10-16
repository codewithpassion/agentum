import type { AgentTab } from "../agent-tabs.ts";

function SettingsPanel() {
  return <p className="text-muted-foreground text-sm">Settings.</p>;
}

export const settingsTab: AgentTab = {
  id: "settings",
  label: "Settings",
  Panel: SettingsPanel,
};
