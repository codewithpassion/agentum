import { useCallback } from "react";
import { JobsPanel } from "#/components/jobs/jobs-panel.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { ArchivedNote, RoomSection, TabBody } from "../section.tsx";

/** The room's Jobs tab: this agent's starts as sentences, and a box to describe a new one. */
export function JobsTab({ onOpenTab, room }: RoomTabProps) {
  const archived = room.agent.status === "archived";
  const openKeys = useCallback(() => onOpenTab("keys"), [onOpenTab]);
  return (
    <TabBody>
      <RoomSection title="Jobs">
        {archived ? <ArchivedNote /> : null}
        <JobsPanel
          agents={[room.agent]}
          fixedAgentId={room.agent.id}
          onOpenKeys={openKeys}
          readOnly={archived}
        />
      </RoomSection>
    </TabBody>
  );
}
