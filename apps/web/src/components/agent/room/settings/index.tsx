import { useCallback } from "react";
import { AsksRow } from "#/components/agent/profile/asks-row.tsx";
import { ComputerCard } from "#/components/agent/profile/computer-card.tsx";
import { RunsOnCard } from "#/components/agent/profile/runs-on-card.tsx";
import { AdvancedPanel } from "#/components/agent/profile/sheets/advanced.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { Manage, RoomSection, TabBody } from "../section.tsx";

const FORM_ID = "room-settings-form";

/** The room's Settings tab: where the agent runs, its computer, and the agent form. */
export function SettingsTab({ room }: RoomTabProps) {
  const archived = room.agent.status === "archived";
  const scrollToForm = useCallback(() => {
    document.getElementById(FORM_ID)?.scrollIntoView({ behavior: "smooth" });
  }, []);
  return (
    <TabBody>
      <div className="grid gap-4 md:grid-cols-2">
        <RunsOnCard header={room.profile.header} onAdvanced={scrollToForm} />
        <Manage archived={archived}>
          <ComputerCard
            agent={room.agent}
            header={room.profile.header}
            machines={room.machines}
          />
        </Manage>
      </div>
      {room.members === null ? null : (
        <RoomSection title="Owner">
          <Manage archived={archived}>
            <AsksRow agent={room.agent} members={room.members} />
          </Manage>
        </RoomSection>
      )}
      <RoomSection title="Edit agent">
        <div id={FORM_ID}>
          <Manage archived={archived}>
            <AdvancedPanel agent={room.agent} />
          </Manage>
        </div>
      </RoomSection>
    </TabBody>
  );
}
