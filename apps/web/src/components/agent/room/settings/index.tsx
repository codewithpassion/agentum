import { useCallback } from "react";
import { AsksRow } from "#/components/agent/profile/asks-row.tsx";
import { ComputerCard } from "#/components/agent/profile/computer-card.tsx";
import { RunsOnCard } from "#/components/agent/profile/runs-on-card.tsx";
import { AdvancedPanel } from "#/components/agent/profile/sheets/advanced.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { RoomSection, TabBody } from "../section.tsx";

const FORM_ID = "room-settings-form";

/** The room's Settings tab: where the agent runs, its computer, and the agent form. */
export function SettingsTab({ room }: RoomTabProps) {
  const scrollToForm = useCallback(() => {
    document.getElementById(FORM_ID)?.scrollIntoView({ behavior: "smooth" });
  }, []);
  return (
    <TabBody>
      <div className="grid gap-4 md:grid-cols-2">
        <RunsOnCard header={room.profile.header} onAdvanced={scrollToForm} />
        <ComputerCard
          agent={room.agent}
          header={room.profile.header}
          machines={room.machines}
        />
      </div>
      {room.members === null ? null : (
        <RoomSection title="Owner">
          <AsksRow agent={room.agent} members={room.members} />
        </RoomSection>
      )}
      <RoomSection title="Edit agent">
        <div id={FORM_ID}>
          <AdvancedPanel agent={room.agent} />
        </div>
      </RoomSection>
    </TabBody>
  );
}
