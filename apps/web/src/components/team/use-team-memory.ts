import type { MemoryNote } from "@repo/db/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";
import {
  type DreamApi,
  useTeamDream,
} from "../agent/room/knows/dream/use-dream.ts";

/** What the Team memory section shows: the team's dreams and its shared notes. */
export interface TeamMemoryApi {
  dream: DreamApi;
  /** The team's shared notes, undefined until the first read. */
  notes: MemoryNote[] | undefined;
  /** Why the notes could not be read, or undefined. */
  notesError: string | undefined;
  /** The moment the dreams were last read, for "today" and "yesterday". */
  nowMs: number;
}

/** The dreams and the notes of one team. A dream or an undo changes the notes, so both read them again. */
export function useTeamMemory(teamId: string): TeamMemoryApi {
  const [notes, setNotes] = useState<MemoryNote[] | undefined>();
  const [notesError, setNotesError] = useState<string | undefined>();
  const [nowMs, setNowMs] = useState(() => Date.now());
  // The team the notes on screen belong to, so a slow reply for another team is dropped.
  const current = useRef(teamId);
  current.current = teamId;

  const reload = useCallback(async () => {
    try {
      const next = await getTrpc().memory.listTeam.query({ teamId });
      if (current.current === teamId) {
        setNotes(next);
        setNotesError(undefined);
        setNowMs(Date.now());
      }
    } catch (cause) {
      if (current.current === teamId) {
        setNotesError(errorMessage(cause));
      }
    }
  }, [teamId]);

  useEffect(() => {
    setNotes(undefined);
    reload();
  }, [reload]);

  const dream = useTeamDream(teamId, reload);
  return { dream, notes, notesError, nowMs };
}
