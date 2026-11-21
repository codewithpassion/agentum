import type { MemoryNote } from "@repo/db/shared";
import type { ReactElement } from "react";
import { DreamCard } from "../agent/room/knows/dream/dream-card.tsx";
import type { DreamApi } from "../agent/room/knows/dream/use-dream.ts";
import { TeamNotes } from "./team-notes.tsx";
import { useTeamMemory } from "./use-team-memory.ts";

const noop = (): void => undefined;

export interface TeamMemoryProps {
  dream: DreamApi;
  notes: readonly MemoryNote[] | undefined;
  notesError: string | undefined;
  nowMs: number;
  teamName: string;
}

/**
 * A team's memory for its owner: the latest team dream with Dream now and
 * Undo, and the notes the team keeps. A team dream applies at once, so there
 * is no held batch to decide and no schedule to set here.
 */
export function TeamMemory({
  dream,
  notes,
  notesError,
  nowMs,
  teamName,
}: TeamMemoryProps): ReactElement {
  const errors = [dream.error, notesError].filter(
    (error) => error !== undefined
  );
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="team-memory">
      {errors.map((error) => (
        <p className="text-destructive text-sm" key={error} role="alert">
          {error}
        </p>
      ))}
      {dream.runs === undefined ? null : (
        <DreamCard
          agentName={teamName}
          canChange
          disabled={false}
          nowMs={nowMs}
          onDecide={noop}
          onRunNow={dream.runNow}
          onUndo={dream.undo}
          pending={dream.pending}
          runs={dream.runs}
        />
      )}
      {notes === undefined ? null : <TeamNotes notes={notes} />}
    </div>
  );
}

/** The Team memory section of the team page: reads the team's dreams and notes, and shows them. */
export function TeamMemoryPanel({
  teamId,
  teamName,
}: {
  teamId: string;
  teamName: string;
}): ReactElement {
  const { dream, notes, notesError, nowMs } = useTeamMemory(teamId);
  return (
    <TeamMemory
      dream={dream}
      notes={notes}
      notesError={notesError}
      nowMs={nowMs}
      teamName={teamName}
    />
  );
}
