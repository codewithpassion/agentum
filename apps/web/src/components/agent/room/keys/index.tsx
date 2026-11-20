import { useCallback } from "react";
import { BrowserSwitch } from "#/components/agent/profile/browser-switch.tsx";
import { mailProvisionLabel } from "#/components/agent/profile/profile-logic.ts";
import { allowedMailAddresses } from "#/components/agent/profile/sheets/mail-logic.ts";
import type { RoomTabProps } from "../room-data.ts";
import { ArchivedNote, RoomSection, TabBody } from "../section.tsx";
import { AppsSection } from "./apps-section.tsx";
import { AskBeforeCard } from "./ask-before-card.tsx";
import { IdentitySection } from "./identity-section.tsx";
import { OtherAgentsSection } from "./other-agents-section.tsx";
import { SecretsSection } from "./secrets-section.tsx";

/**
 * The room's Keys tab: the apps the agent can use and whose sign-in each
 * uses, its own identity, passwords and keys, the other agents it works with,
 * and what it asks first.
 */
export function KeysTab({ onOpenTab, room }: RoomTabProps) {
  const { agent, keys } = room;
  const archived = agent.status === "archived";
  const openSettings = useCallback(() => onOpenTab("settings"), [onOpenTab]);
  const asksBefore = (
    <AskBeforeCard
      actions={room.askBefore}
      agentId={agent.id}
      archived={archived}
      level={room.askLevel}
      mailAllowed={allowedMailAddresses(room.rules)}
      onEditSettings={openSettings}
    />
  );
  if (archived) {
    // One note, not one per section: nothing here can change an archived agent.
    return (
      <TabBody>
        <ArchivedNote />
        {asksBefore}
      </TabBody>
    );
  }
  if (keys === null) {
    return (
      <TabBody>
        <p className="text-destructive text-sm" role="alert">
          Keys could not be loaded. Reload the page to try again.
        </p>
        {asksBefore}
      </TabBody>
    );
  }
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
      <RoomSection title="Apps it can use">
        <BrowserSwitch agent={agent} />
        <AppsSection agent={agent} apps={keys.apps} />
      </RoomSection>
      <IdentitySection
        agent={agent}
        identity={keys.identity}
        provisionLabel={provisionLabel}
      />
      <SecretsSection agent={agent} secrets={keys.secrets} />
      <OtherAgentsSection
        agent={agent}
        connections={room.connections}
        otherAgents={keys.otherAgents}
        published={room.published}
      />
      {asksBefore}
    </TabBody>
  );
}
