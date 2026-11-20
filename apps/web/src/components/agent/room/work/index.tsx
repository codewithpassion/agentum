import { RecentTasksCard } from "#/components/agent/profile/recent-tasks-card.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { TabBody } from "../section.tsx";

/** The room's Work tab: the agent's recent tasks. */
export function WorkTab({ nowMs, room }: RoomTabProps) {
  return (
    <TabBody>
      <RecentTasksCard
        agentId={room.agent.id}
        nowMs={nowMs}
        tasks={room.tasks}
      />
    </TabBody>
  );
}
