import type { AgentKeys } from "@repo/db/shared";
import { ConnectionsCard } from "#/components/agent/profile/connections-card.tsx";
import { HandsToPanel } from "#/components/agent/profile/sheets/hands-to.tsx";
import { SubagentsSwitch } from "#/components/agent/profile/subagents-switch.tsx";
import { WorksWith } from "#/components/agent/profile/works-with.tsx";
import { isEnded } from "#/components/connections/connections-logic.ts";
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
  /** Null when the read model did not load: the summary lines are left out. */
  otherAgents: AgentKeys["otherAgents"] | null;
  published: RouterOutputs["a2a"]["published"] | null;
}) {
  return (
    <RoomSection title="Other agents">
      {otherAgents === null ? null : <Summary otherAgents={otherAgents} />}
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

/** Hands-to and live connections, as the Connections card below counts them: an ended or unused invite is left out. */
function Summary({ otherAgents }: { otherAgents: AgentKeys["otherAgents"] }) {
  const live = otherAgents.connections.filter(
    (connection) =>
      !isEnded(connection.status) && connection.status !== "inviting"
  );
  return (
    <>
      <p className="text-sm">{handsToWords(otherAgents.handsTo)}</p>
      {live.length === 0 ? (
        <p className="text-sm">Not connected to any other agent.</p>
      ) : (
        <ul>
          {live.map((connection) => (
            <li className="text-sm" key={connection.connectionId}>
              {connectionWords(connection)}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
