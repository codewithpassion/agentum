import { RecentTasksCard } from "#/components/agent/profile/recent-tasks-card.tsx";
import { NowPanel } from "../now/index.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { TabBody } from "../section.tsx";

/** The room's Work tab: the agent's recent tasks, with the Right now panel beside them. */
export function WorkTab({ nowMs, room }: RoomTabProps) {
  const archived = room.agent.status === "archived";
  return (
    <TabBody>
      <div className="@container min-w-0">
        <div
          className={`grid min-w-0 @3xl:items-start gap-4 ${archived ? "" : "@3xl:grid-cols-[minmax(0,1fr)_18rem]"}`}
        >
          <RecentTasksCard
            agentId={room.agent.id}
            nowMs={nowMs}
            tasks={room.tasks}
          />
          {archived ? null : (
            <div className="@3xl:order-none order-first @3xl:max-h-[calc(100dvh-var(--app-header-h))] min-w-0 @3xl:overflow-y-auto">
              <NowPanel nowMs={nowMs} room={room} />
            </div>
          )}
        </div>
      </div>
    </TabBody>
  );
}
