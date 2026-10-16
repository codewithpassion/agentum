import type { AgentTab } from "../agent-tabs.ts";

function TriggersPanel() {
  return (
    <p className="text-muted-foreground text-sm">Triggers arrive in M4.</p>
  );
}

export const triggersTab: AgentTab = {
  id: "triggers",
  label: "Triggers",
  Panel: TriggersPanel,
};
