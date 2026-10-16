import type { AgentTab } from "../agent-tabs.ts";

function ChatPanel() {
  return <p className="text-muted-foreground text-sm">Chat.</p>;
}

export const chatTab: AgentTab = {
  id: "chat",
  label: "Chat",
  Panel: ChatPanel,
};
