import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";
import { AsksRow } from "#/components/agent/profile/asks-row.tsx";
import { ComputerCard } from "#/components/agent/profile/computer-card.tsx";
import { RunsOnCard } from "#/components/agent/profile/runs-on-card.tsx";
import { AdvancedPanel } from "#/components/agent/profile/sheets/advanced.tsx";
import { CapField } from "#/components/spend/cap-field.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { RoomTabProps } from "../room-data.ts";
import { Manage, RoomSection, TabBody } from "../section.tsx";

const FORM_ID = "room-settings-form";

/** The room's Settings tab: where the agent runs, its computer, and the agent form. */
export function SettingsTab({ room }: RoomTabProps) {
  const archived = room.agent.status === "archived";
  const agentId = room.agent.id;
  const router = useRouter();
  const scrollToForm = useCallback(() => {
    document.getElementById(FORM_ID)?.scrollIntoView({ behavior: "smooth" });
  }, []);
  const saveAgentCap = useCallback(
    async (cents: number | null) => {
      await getTrpc().spend.setCap.mutate({
        agentId,
        weeklyCapCents: cents,
      });
      // The header's spend line reads the same limit.
      await router.invalidate();
    },
    [agentId, router]
  );
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
      <RoomSection title="Weekly spend limit">
        <Manage archived={archived}>
          <CapField
            help="Runs stop starting once this agent has spent this much in a week. A task already running finishes. Leave empty for no limit."
            id="agent-cap"
            label="Weekly limit"
            onSave={saveAgentCap}
            savedCents={room.spend.capCents}
          />
        </Manage>
      </RoomSection>
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
