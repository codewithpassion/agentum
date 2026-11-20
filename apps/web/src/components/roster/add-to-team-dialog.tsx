import type { AgentCard, Team } from "@repo/db/shared";
import { useCallback, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import { cn } from "#/lib/utils";
import { AVATAR_CLASSES } from "./roster-logic.ts";

const FALLBACK_ERROR = "Could not add the agent.";

/** The agents that are not yet members of the team, by name. */
export const addCandidates = (
  team: Team,
  cards: readonly AgentCard[]
): AgentCard[] => {
  const memberIds = new Set(
    team.members
      .filter((member) => member.memberKind === "agent")
      .map((member) => member.memberId)
  );
  return cards
    .filter((card) => !memberIds.has(card.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
};

/** One candidate row. The whole row is the button. */
const CandidateRow = ({
  card,
  disabled,
  homeTeamName,
  onPick,
  pending,
}: {
  card: AgentCard;
  disabled: boolean;
  homeTeamName: string | undefined;
  onPick: (agentId: string) => void;
  pending: boolean;
}) => {
  const handleClick = useCallback(() => onPick(card.id), [card.id, onPick]);
  return (
    <li>
      <button
        className="flex w-full min-w-0 items-center gap-3 rounded-lg p-2 text-left hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2 disabled:opacity-60"
        disabled={disabled}
        onClick={handleClick}
        type="button"
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg font-semibold text-sm text-white",
            AVATAR_CLASSES[card.avatar.color]
          )}
        >
          {card.avatar.glyph}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{card.name}</span>
          {card.jobLine === "" ? null : (
            <span className="truncate text-muted-foreground text-sm">
              {card.jobLine}
            </span>
          )}
          {homeTeamName === undefined ? null : (
            <span className="truncate text-muted-foreground text-xs">
              {`In ${homeTeamName}`}
            </span>
          )}
        </span>
        {pending ? (
          <span className="shrink-0 text-muted-foreground text-sm">
            Adding...
          </span>
        ) : null}
      </button>
    </li>
  );
};

/** Pick an agent from the candidates. The whole row is the button. */
export const AddToTeamPicker = ({
  candidates,
  error,
  homeTeamNames,
  onPick,
  pendingId,
}: {
  candidates: readonly AgentCard[];
  error: string | null;
  homeTeamNames: ReadonlyMap<string, string>;
  onPick: (agentId: string) => void;
  pendingId: string | null;
}) => {
  if (candidates.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        Every agent is already in this team.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-1">
        {candidates.map((card) => (
          <CandidateRow
            card={card}
            disabled={pendingId !== null}
            homeTeamName={
              card.teamId === null ? undefined : homeTeamNames.get(card.teamId)
            }
            key={card.id}
            onPick={onPick}
            pending={pendingId === card.id}
          />
        ))}
      </ul>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

/** Dialog that adds one agent to a team. It closes once the add succeeds. */
export const AddToTeamDialog = ({
  cards,
  onAdd,
  onClose,
  team,
  teams,
}: {
  cards: readonly AgentCard[];
  onAdd: (teamId: string, agentId: string) => Promise<void>;
  onClose: () => void;
  team: Team;
  teams: readonly Team[];
}) => {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => addCandidates(team, cards), [team, cards]);
  const homeTeamNames = useMemo(
    () => new Map(teams.map((item) => [item.id, item.name])),
    [teams]
  );

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        onClose();
      }
    },
    [onClose]
  );

  const handlePick = useCallback(
    async (agentId: string) => {
      setPendingId(agentId);
      setError(null);
      try {
        await onAdd(team.id, agentId);
        onClose();
      } catch (caught: unknown) {
        setError(
          caught instanceof Error && caught.message !== ""
            ? caught.message
            : FALLBACK_ERROR
        );
        setPendingId(null);
      }
    },
    [onAdd, onClose, team.id]
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
        <AddToTeamPicker
          candidates={candidates}
          error={error}
          homeTeamNames={homeTeamNames}
          onPick={handlePick}
          pendingId={pendingId}
        />
      </DialogContent>
    </Dialog>
  );
};
