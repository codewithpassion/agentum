import { Link } from "@tanstack/react-router";
import { NewTaskDialog } from "#/components/desk/new-task-dialog.tsx";
import {
  agentInitials,
  agentTileColour,
} from "#/components/shell/agent-tile.ts";
import { Button } from "#/components/ui/button.tsx";
import type { AgentProfileView } from "#/integrations/trpc/types";
import { AddressChip } from "./address-chip.tsx";
import { runtimeWords, statusText } from "./profile-logic.ts";

/** Tile, name, address, runtime and status, with Edit and Run now. */
export function ProfileHeader({
  header,
  onEdit,
  onStarted,
}: {
  header: AgentProfileView["header"];
  onEdit: () => void;
  onStarted: (runId: string) => void;
}) {
  const status = statusText(header);
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
          <AddressChip
            agentId={header.id}
            emailLocal={header.emailLocal}
            suggestion={header.slug}
          />
          <span className="rounded-full border border-border px-2.5 py-0.5 text-xs">
            {runtimeWords(header.runtime, header.machine)}
          </span>
          {status === null ? null : (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 font-semibold text-amber-900 text-xs">
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
