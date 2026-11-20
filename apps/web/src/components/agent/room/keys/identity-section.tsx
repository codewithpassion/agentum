import type { AgentKeys } from "@repo/db/shared";
import { MailProvisionButton } from "#/components/agent/profile/mail-provision-button.tsx";
import { SlackPanel } from "#/components/agent/profile/sheets/slack.tsx";
import type { AgentRecord } from "#/integrations/trpc/types";
import { RoomSection } from "../section.tsx";
import { emailWords, slackWords } from "./keys-logic.ts";

/** The agent's own email address and Slack app, with the controls to set them up. */
export function IdentitySection({
  agent,
  canManage,
  identity,
  provisionLabel,
}: {
  agent: AgentRecord;
  /** Whether the person may set up the Slack app: an org admin or the agent's owner. */
  canManage: boolean;
  /** Null when the read model did not load: the lines are left out, the controls stay. */
  identity: AgentKeys["identity"] | null;
  provisionLabel: string | null;
}) {
  return (
    <RoomSection title="Its own identity">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-muted-foreground text-sm">Email</h3>
          {identity === null ? null : (
            <p className="text-sm">{emailWords(identity.emailAddress)}</p>
          )}
          {provisionLabel === null ? null : (
            <MailProvisionButton agentId={agent.id} label={provisionLabel} />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-muted-foreground text-sm">Slack</h3>
          {identity === null ? null : (
            <p className="text-sm">{slackWords(identity.slackApp)}</p>
          )}
          {canManage ? (
            <SlackPanel agent={agent} />
          ) : (
            <p className="text-muted-foreground text-xs">
              Only the agent&apos;s owners and admins can set up its Slack app.
            </p>
          )}
        </div>
      </div>
    </RoomSection>
  );
}
