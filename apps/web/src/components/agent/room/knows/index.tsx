import { SkillsPanel } from "#/components/agent/profile/sheets/skills.tsx";
import { VoiceField } from "#/components/agent/profile/voice-field.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { Manage, RoomSection, TabBody } from "../section.tsx";
import { DoesText } from "./does-text.tsx";

/** The room's Knows tab: what the agent is told to do, its voice and its skills. */
export function KnowsTab({ room }: RoomTabProps) {
  const archived = room.agent.status === "archived";
  return (
    <TabBody>
      <RoomSection title="Instructions">
        <DoesText does={room.profile.does} full={archived} />
      </RoomSection>
      <RoomSection title="Voice">
        <VoiceField agentId={room.agent.id} voice={room.profile.voice} />
      </RoomSection>
      <RoomSection title="Skills">
        <Manage archived={room.agent.status === "archived"}>
          <SkillsPanel agent={room.agent} />
        </Manage>
      </RoomSection>
    </TabBody>
  );
}
