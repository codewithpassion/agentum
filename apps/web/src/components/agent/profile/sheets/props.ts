import type { AgentRecord } from "#/integrations/trpc/types";

/** What the profile page hands every manage sheet panel. */
export interface AgentPanelProps {
  agent: AgentRecord;
}
