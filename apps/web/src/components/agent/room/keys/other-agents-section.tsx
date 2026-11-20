import type { AgentKeys } from "@repo/db/shared";
import { ConnectionsCard } from "#/components/agent/profile/connections-card.tsx";
import { HandsToPanel } from "#/components/agent/profile/sheets/hands-to.tsx";
import { SubagentsSwitch } from "#/components/agent/profile/subagents-switch.tsx";
import { WorksWith } from "#/components/agent/profile/works-with.tsx";
import type { AgentRecord, RouterOutputs } from "#/integrations/trpc/types";
import { RoomSection } from "../section.tsx";
import { connectionWords, handsToWords } from "./keys-logic.ts";

/** The Keys tab's other agents: who this agent hands work to, who it is connected to, and the controls for both. */
export function OtherAgentsSection({
  agent,
  connections,
  otherAgents,
  published,
}: {
  agent: AgentRecord;
  connections: RouterOutputs["a2a"]["list"];
  otherAgents: AgentKeys["otherAgents"];
  published: RouterOutputs["a2a"]["published"] | null;
}) {
  return (
    <RoomSection title="Other agents">
      <p className="text-sm">{handsToWords(otherAgents.handsTo)}</p>
      {otherAgents.connections.length === 0 ? (
        <p className="text-sm">
          Not connected to any agent outside this workspace.
        </p>
      ) : (
        <ul>
          {otherAgents.connections.map((connection) => (
            <li className="text-sm" key={connection.connectionId}>
              {connectionWords(connection)}
            </li>
          ))}
        </ul>
      )}
      <WorksWith
        handsTo={<HandsToPanel agent={agent} />}
        peers={
          <div className="[&>section]:border-0 [&>section]:bg-transparent [&_h2]:sr-only">
            <ConnectionsCard
              agentId={agent.id}
              connections={connections}
              published={published}
            />
          </div>
        }
        subagents={<SubagentsSwitch agent={agent} />}
      />
    </RoomSection>
  );
}
