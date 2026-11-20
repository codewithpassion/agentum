import { MailStartChip } from "#/components/agent/profile/mail-start-chip.tsx";
import { RoutinesPanel } from "#/components/agent/profile/sheets/routines.tsx";
import { TriggersPanel } from "#/components/agent/profile/sheets/triggers.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { Manage, RoomSection, TabBody } from "../section.tsx";

/** The room's Jobs tab: what starts the agent, and the routines it runs. */
export function JobsTab({ room }: RoomTabProps) {
  const { mailbox } = room;
  const archived = room.agent.status === "archived";
  return (
    <TabBody>
      <RoomSection title="Triggers">
        <Manage archived={archived}>
          <TriggersPanel agent={room.agent} />
        </Manage>
        {mailbox === null || mailbox.status === "disabled" ? null : (
          <MailStartChip
            address={mailbox.address}
            agentId={room.agent.id}
            key={mailbox.triggerDisabledAt === null ? "running" : "paused"}
            paused={mailbox.triggerDisabledAt !== null}
          />
        )}
      </RoomSection>
      <RoomSection title="Routines">
        <Manage archived={archived}>
          <RoutinesPanel agent={room.agent} />
        </Manage>
      </RoomSection>
    </TabBody>
  );
}
