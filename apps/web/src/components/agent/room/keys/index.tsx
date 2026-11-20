import { useAuth } from "@clerk/tanstack-react-start";
import { useCallback } from "react";
import { canManageAgentKeys } from "#/components/agent/agent-rights.ts";
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
 * and what it asks first. Only an org admin or the agent's owner can change
 * the apps, the Slack app and the secret grants, so the passwords and keys
 * show to them alone.
 */
export function KeysTab({ onOpenTab, room }: RoomTabProps) {
  const { agent, keys } = room;
  const { orgRole, userId } = useAuth();
  const canManage = canManageAgentKeys({
    agent,
    isAdmin: orgRole === "org:admin",
    userId,
  });
  const archived = agent.status === "archived";
  const openSettings = useCallback(() => onOpenTab("settings"), [onOpenTab]);
  const asksBefore = (
    <AskBeforeCard
      actions={room.askBefore}
      agentId={agent.id}
      archived={archived}
      canManage={canManage}
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
      {keys === null ? (
        <p className="text-destructive text-sm" role="alert">
          Keys could not be loaded. Reload the page to try again.
        </p>
      ) : null}
      <RoomSection title="Apps it can use">
        <BrowserSwitch agent={agent} />
        {keys === null ? null : <AppsSection agent={agent} apps={keys.apps} />}
      </RoomSection>
      <IdentitySection
        agent={agent}
        canManage={canManage}
        identity={keys === null ? null : keys.identity}
        provisionLabel={provisionLabel}
      />
      {canManage ? (
        <SecretsSection
          agent={agent}
          secrets={keys === null ? null : keys.secrets}
        />
      ) : null}
      <OtherAgentsSection
        agent={agent}
        canManage={canManage}
        connections={room.connections}
        otherAgents={keys === null ? null : keys.otherAgents}
        published={room.published}
      />
      {asksBefore}
    </TabBody>
  );
}
