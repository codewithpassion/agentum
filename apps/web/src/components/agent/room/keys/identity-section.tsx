import type { AgentKeys } from "@repo/db/shared";
import { MailProvisionButton } from "#/components/agent/profile/mail-provision-button.tsx";
import { SlackPanel } from "#/components/agent/profile/sheets/slack.tsx";
import type { AgentRecord } from "#/integrations/trpc/types";
import { RoomSection } from "../section.tsx";
import { emailWords, slackWords } from "./keys-logic.ts";

/** The agent's own email address and Slack app, with the controls to set them up. */
export function IdentitySection({
  agent,
  identity,
  provisionLabel,
}: {
  agent: AgentRecord;
  identity: AgentKeys["identity"];
  provisionLabel: string | null;
}) {
  return (
    <RoomSection title="Its own identity">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-muted-foreground text-sm">Email</h3>
          <p className="text-sm">{emailWords(identity.emailAddress)}</p>
          {provisionLabel === null ? null : (
            <MailProvisionButton agentId={agent.id} label={provisionLabel} />
          )}
        </div>
        <div className="flex flex-col gap-2">
          <h3 className="font-medium text-muted-foreground text-sm">Slack</h3>
          <p className="text-sm">{slackWords(identity.slackApp)}</p>
          <SlackPanel agent={agent} />
        </div>
      </div>
    </RoomSection>
  );
}
