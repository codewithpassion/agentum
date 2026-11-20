import { Link } from "@tanstack/react-router";
import { AddressChip } from "#/components/agent/profile/address-chip.tsx";
import { MailProvisionButton } from "#/components/agent/profile/mail-provision-button.tsx";
import { MailStatus } from "#/components/agent/profile/mail-status.tsx";
import {
  mailProvisionLabel,
  runtimeWords,
  statusText,
} from "#/components/agent/profile/profile-logic.ts";
import { NewTaskDialog } from "#/components/desk/new-task-dialog.tsx";
import {
  agentInitials,
  agentTileColour,
} from "#/components/shell/agent-tile.ts";
import { capLine } from "#/components/spend/spend-logic.ts";
import { Button } from "#/components/ui/button.tsx";
import { jobLine, ownerName } from "./header-logic.ts";
import type { RoomData } from "./room-data.ts";

/** Avatar, name, job line, owner, address, where it runs, and Run now. */
export function RoomHeader({
  onEdit,
  onOpenMail,
  onStarted,
  room,
}: {
  onEdit: () => void;
  onOpenMail: () => void;
  onStarted: (runId: string) => void;
  room: Pick<RoomData, "agent" | "mailbox" | "members" | "profile" | "spend">;
}) {
  const { agent, mailbox, members, profile, spend } = room;
  const spendLine =
    spend.weekCents === null ? null : capLine(spend.weekCents, spend.capCents);
  const { header } = profile;
  const status = statusText(header);
  const job = jobLine(profile.does);
  const owner = ownerName(agent, members);
  const setUpLabel = mailProvisionLabel(
    header.status,
    header.emailLocal,
    mailbox?.status ?? null
  );
  const agents = [{ id: header.id, name: header.name }];
  return (
    <header className="flex flex-wrap items-center gap-3.5">
      <span
        aria-hidden="true"
        className={`grid size-[52px] shrink-0 place-items-center rounded-xl font-bold text-lg text-white ${agentTileColour(header.name)}`}
      >
        {agentInitials(header.name)}
      </span>
      <div className="min-w-0 flex-[1_1_300px]">
        <h1 className="font-heading text-2xl text-foreground">{header.name}</h1>
        <p
          className="max-w-prose truncate text-muted-foreground text-sm"
          data-testid="room-job-line"
        >
          {job ?? "No instructions yet."}
          {owner === null ? null : ` · Owner: ${owner}`}
        </p>
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
          {spendLine === null ? null : (
            <span
              className="rounded-full border border-border px-2.5 py-0.5 text-xs"
              data-testid="room-spend-line"
            >
              {spendLine}
            </span>
          )}
          {spend.paused ? (
            <span className="rounded-full bg-destructive/15 px-2 py-0.5 font-semibold text-destructive text-xs">
              Paused. Weekly limit reached
            </span>
          ) : null}
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
      {header.status === "archived" ? null : (
        <>
          <Button onClick={onEdit} variant="outline">
            Edit
          </Button>
          <NewTaskDialog
            agents={agents}
            onStarted={onStarted}
            triggerLabel="Run now"
          />
        </>
      )}
    </header>
  );
}
