import { RecentTasksCard } from "#/components/agent/profile/recent-tasks-card.tsx";
import { NowPanel } from "../now/index.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { TabBody } from "../section.tsx";

/** The room's Work tab: the agent's recent tasks, with the Right now panel beside them. */
export function WorkTab({ nowMs, room }: RoomTabProps) {
  const archived = room.agent.status === "archived";
  return (
    <TabBody>
      <div
        className={`grid min-w-0 gap-4 lg:items-start ${archived ? "" : "lg:grid-cols-[minmax(0,1fr)_18rem]"}`}
      >
        <RecentTasksCard
          agentId={room.agent.id}
          nowMs={nowMs}
          tasks={room.tasks}
        />
        {archived ? null : (
          <div className="order-first min-w-0 lg:order-none">
            <NowPanel nowMs={nowMs} room={room} />
          </div>
        )}
      </div>
    </TabBody>
  );
}
