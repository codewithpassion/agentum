import { useAuth } from "@clerk/tanstack-react-start";
import type { RoomTabProps } from "../room-data.ts";
import { TabBody } from "../section.tsx";
import { KnowsLayout } from "./knows-layout.tsx";
import { canChangeRules } from "./rules-logic.ts";
import { useMemory } from "./use-memory.ts";

/**
 * The room's Knows tab: what the agent remembers, the rules for what it
 * keeps, what it learned this week, and its instructions, voice and skills.
 */
export function KnowsTab({ room }: RoomTabProps) {
  const { orgRole, userId } = useAuth();
  const memory = useMemory(room.agent.id);
  const canChange = canChangeRules({
    isAdmin: orgRole === "org:admin",
    ownerUserId: room.agent.ownerUserId ?? room.agent.createdBy,
    userId: userId ?? null,
  });
  return (
    <TabBody>
      <KnowsLayout canChange={canChange} memory={memory} room={room} />
    </TabBody>
  );
}
