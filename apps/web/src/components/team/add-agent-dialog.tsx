import type { Team } from "@repo/db/shared";
import { type FormEvent, useCallback, useId, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { AddMemberForm } from "./add-member-form.tsx";
import { addableAgents, type TeamAgent } from "./team-logic.ts";

const FALLBACK_ERROR = "Could not add the agent.";

/** Pick an agent that is not yet in the team and add it. Calls onAdded after a successful add. */
export function AddAgentForm({
  agents,
  onAdd,
  onAdded,
  team,
}: {
  agents: readonly TeamAgent[];
  onAdd: (teamId: string, agentId: string) => Promise<void>;
  onAdded?: () => void;
  team: Team;
}) {
  const selectId = useId();
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choices = useMemo(() => addableAgents(team, agents), [team, agents]);
  // A choice that is no longer addable (someone else added it) counts as no choice.
  const chosen = choices.some((agent) => agent.id === choice) ? choice : "";

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (busy || chosen === "") {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await onAdd(team.id, chosen);
        setChoice("");
        setBusy(false);
        onAdded?.();
      } catch (caught: unknown) {
        setError(
          caught instanceof Error && caught.message !== ""
            ? caught.message
            : FALLBACK_ERROR
        );
        setBusy(false);
      }
    },
    [busy, chosen, onAdd, onAdded, team.id]
  );

  if (choices.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Every agent is already in this team.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <AddMemberForm
        busy={busy}
        choice={chosen}
        choices={choices.map((agent) => ({ id: agent.id, label: agent.name }))}
        onChange={setChoice}
        onSubmit={handleSubmit}
        placeholder="Choose an agent"
        selectId={selectId}
        title="Add an agent"
      />
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Dialog that adds one agent to a team. It closes once the add succeeds. */
export function AddAgentDialog({
  agents,
  onAdd,
  onClose,
  team,
}: {
  agents: readonly TeamAgent[];
  onAdd: (teamId: string, agentId: string) => Promise<void>;
  onClose: () => void;
  team: Team;
}) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{`Add to ${team.name}`}</DialogTitle>
          <DialogDescription>
            Pick an agent to add to this team.
          </DialogDescription>
        </DialogHeader>
        <AddAgentForm
          agents={agents}
          onAdd={onAdd}
          onAdded={onClose}
          team={team}
        />
      </DialogContent>
    </Dialog>
  );
}
