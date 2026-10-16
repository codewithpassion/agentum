import type { AgentTab } from "../agent-tabs.ts";

function ConnectorsPanel() {
  return (
    <p className="text-muted-foreground text-sm">Connectors arrive in M3.</p>
  );
}

export const connectorsTab: AgentTab = {
  id: "connectors",
  label: "Connectors",
  Panel: ConnectorsPanel,
};
