import { Link } from "@tanstack/react-router";
import { NewTaskDialog } from "#/components/desk/new-task-dialog.tsx";
import {
  agentInitials,
  agentTileColour,
} from "#/components/shell/agent-tile.ts";
import { Button } from "#/components/ui/button.tsx";
import type {
  AgentProfileView,
  MailboxRecord,
} from "#/integrations/trpc/types";
import { AddressChip } from "./address-chip.tsx";
import { MailProvisionButton } from "./mail-provision-button.tsx";
import { MailStatus } from "./mail-status.tsx";
import {
  mailProvisionLabel,
  runtimeWords,
  statusText,
} from "./profile-logic.ts";

/** Tile, name, address, runtime and status, with Edit and Run now. */
export function ProfileHeader({
  header,
  mailbox,
  onEdit,
  onOpenMail,
  onStarted,
}: {
  header: AgentProfileView["header"];
  mailbox: MailboxRecord | null;
  onEdit: () => void;
  onOpenMail: () => void;
  onStarted: (runId: string) => void;
}) {
  const status = statusText(header);
  const setUpLabel = mailProvisionLabel(
    header.status,
    header.emailLocal,
    mailbox?.status ?? null
  );
  const agents = [{ id: header.id, name: header.name }];
  return (
    <header className="flex flex-wrap items-center gap-3.5">
      <span
        className={`grid size-[52px] shrink-0 place-items-center rounded-xl font-bold text-lg text-white ${agentTileColour(header.name)}`}
      >
        {agentInitials(header.name)}
      </span>
      <div className="min-w-0 flex-[1_1_300px]">
        <h1 className="font-heading text-2xl text-foreground">{header.name}</h1>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {mailbox === null ? (
            <>
              <AddressChip
                agentId={header.id}
                emailLocal={header.emailLocal}
                suggestion={header.slug}
              />
              {setUpLabel === null ? null : (
                <MailProvisionButton agentId={header.id} label={setUpLabel} />
              )}
            </>
          ) : (
            <MailStatus
              agentId={header.id}
              agentStatus={header.status}
              emailLocal={header.emailLocal}
              mailbox={mailbox}
              onOpenMail={onOpenMail}
            />
          )}
          <span className="rounded-full border border-border px-2.5 py-0.5 text-xs">
            {runtimeWords(header.runtime, header.machine)}
          </span>
          {status === null ? null : (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 font-semibold text-warning text-xs">
              {status.runId === null ? (
                status.label
              ) : (
                <Link params={{ runId: status.runId }} to="/tasks/$runId">
                  {status.label}
                </Link>
              )}
            </span>
          )}
        </div>
      </div>
      <Button onClick={onEdit} variant="outline">
        Edit
      </Button>
      <NewTaskDialog
        agents={agents}
        onStarted={onStarted}
        triggerLabel="Run now"
      />
    </header>
  );
}
