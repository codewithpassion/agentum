import type { AgentStatus } from "@repo/db/shared";
import type { MailboxRecord } from "#/integrations/trpc/types";
import { CHIP_CLASS } from "./address-chip.tsx";
import { MailProvisionButton } from "./mail-provision-button.tsx";
import { mailProvisionLabel } from "./profile-logic.ts";
import { mailboxStatusLabel } from "./sheets/mail-logic.ts";

const TONE_CLASS = {
  bad: "border-destructive text-destructive",
  default: "border-border",
  on: "border-primary text-primary",
  warn: "border-amber-300 bg-amber-100 text-amber-900",
} as const;

/** The agent's mail address, its status, and a retry when provisioning failed or is still pending. */
export function MailStatus({
  agentId,
  agentStatus,
  emailLocal,
  mailbox,
  onOpenMail,
}: {
  agentId: string;
  agentStatus: AgentStatus;
  emailLocal: string | null;
  mailbox: MailboxRecord;
  onOpenMail: () => void;
}) {
  const status = mailboxStatusLabel(mailbox.status);
  const provisionLabel = mailProvisionLabel(
    agentStatus,
    emailLocal,
    mailbox.status
  );

  return (
    <>
      <button
        className={`${CHIP_CLASS} border-primary bg-primary/10 font-mono text-primary`}
        onClick={onOpenMail}
        type="button"
      >
        {mailbox.address}
      </button>
      {mailbox.status === "active" ? null : (
        <span className={`${CHIP_CLASS} ${TONE_CLASS[status.tone]}`}>
          {status.label}
        </span>
      )}
      {mailbox.status === "failed" && mailbox.lastError !== null ? (
        <span
          className="max-w-xs truncate text-muted-foreground text-xs"
          title={mailbox.lastError}
        >
          {mailbox.lastError}
        </span>
      ) : null}
      {provisionLabel === null ? null : (
        <MailProvisionButton agentId={agentId} label={provisionLabel} />
      )}
    </>
  );
}
