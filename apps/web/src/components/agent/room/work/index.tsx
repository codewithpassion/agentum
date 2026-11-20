import { RecentTasksCard } from "#/components/agent/profile/recent-tasks-card.tsx";
import { NowPanel } from "../now/index.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { TabBody } from "../section.tsx";

/** The room's Work tab: the agent's recent tasks, with the Right now panel beside them. */
export function WorkTab({ nowMs, room }: RoomTabProps) {
  return (
    <TabBody>
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <RecentTasksCard
          agentId={room.agent.id}
          nowMs={nowMs}
          tasks={room.tasks}
        />
        <div className="order-first min-w-0 empty:hidden lg:order-none">
          <NowPanel nowMs={nowMs} room={room} />
        </div>
      </div>
    </TabBody>
  );
}
