import { useCallback } from "react";
import { AskBeforeCard } from "#/components/agent/profile/ask-before-card.tsx";
import { BrowserSwitch } from "#/components/agent/profile/browser-switch.tsx";
import { ConnectionsCard } from "#/components/agent/profile/connections-card.tsx";
import { MailProvisionButton } from "#/components/agent/profile/mail-provision-button.tsx";
import { mailProvisionLabel } from "#/components/agent/profile/profile-logic.ts";
import { ConnectorsPanel } from "#/components/agent/profile/sheets/connectors.tsx";
import { HandsToPanel } from "#/components/agent/profile/sheets/hands-to.tsx";
import { allowedMailAddresses } from "#/components/agent/profile/sheets/mail-logic.ts";
import { SecretsPanel } from "#/components/agent/profile/sheets/secrets.tsx";
import { SlackPanel } from "#/components/agent/profile/sheets/slack.tsx";
import { SubagentsSwitch } from "#/components/agent/profile/subagents-switch.tsx";
import { WorksWith } from "#/components/agent/profile/works-with.tsx";
import type { RoomTabProps } from "../room-data.ts";
import { RoomSection, TabBody } from "../section.tsx";

/** The room's Keys tab: the agent's tools, channels, the agents it works with, and what needs asking first. */
export function KeysTab({ onOpenTab, room }: RoomTabProps) {
  const openSettings = useCallback(() => onOpenTab("settings"), [onOpenTab]);
  const provisionLabel =
    room.mailbox === null
      ? mailProvisionLabel(
          room.profile.header.status,
          room.profile.header.emailLocal,
          null
        )
      : null;
  return (
    <TabBody>
      <RoomSection title="Tools">
        <BrowserSwitch agent={room.agent} />
        <ConnectorsPanel agent={room.agent} />
        <SecretsPanel agent={room.agent} />
      </RoomSection>
      <RoomSection title="Channels">
        <SlackPanel agent={room.agent} />
        {provisionLabel === null ? null : (
          <MailProvisionButton agentId={room.agent.id} label={provisionLabel} />
        )}
      </RoomSection>
      <WorksWith
        handsTo={<HandsToPanel agent={room.agent} />}
        peers={
          <div className="[&>section]:border-0 [&>section]:bg-transparent [&_h2]:sr-only">
            <ConnectionsCard
              agentId={room.agent.id}
              connections={room.connections}
              published={room.published}
            />
          </div>
        }
        subagents={<SubagentsSwitch agent={room.agent} />}
      />
      <RoomSection title="Ask before">
        <AskBeforeCard
          actions={room.askBefore}
          agentId={room.agent.id}
          archived={room.agent.status === "archived"}
          level={room.askLevel}
          mailAllowed={allowedMailAddresses(room.rules)}
          onEditSettings={openSettings}
        />
      </RoomSection>
    </TabBody>
  );
}
