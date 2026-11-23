import {
  type DreamDecision,
  type DreamRun,
  RAIL_REFRESH_EVENT,
} from "@repo/db/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

/** What the dream card waits for: a dream started here, a night being undone, or a held batch being approved or rejected. */
export type DreamPending = "run" | "undo" | DreamDecision;

/** One agent's or one team's dreams and the actions on them. */
export interface DreamApi {
  decide: (dreamRunId: string, decision: DreamDecision) => void;
  error: string | undefined;
  pending: DreamPending | null;
  runNow: () => void;
  /** Every dream of the agent or team, undefined until the first read. */
  runs: DreamRun[] | undefined;
  undo: (dreamRunId: string) => void;
}

/** What the shared dream hook needs from the agent or team it reads. */
interface DreamSource {
  /** Approves or rejects a held batch. A team never holds one, so a team passes a no-op. */
  decide: (dreamRunId: string, decision: DreamDecision) => Promise<unknown>;
  /** The agent or team id. A new id starts a new read and drops the replies for the old one. */
  id: string;
  /** Reads every dream of the agent or team. Must be stable while `id` is. */
  list: () => Promise<DreamRun[]>;
  /** Starts a dream now. Must be stable while `id` is. */
  start: () => Promise<unknown>;
}

/** How long a dream that is still running waits before the card asks again. */
export const RUNNING_POLL_MS = 3000;

/** The agent's held batch decision. It also tells the Needs you card to read again. */
async function decideAgentDream(
  dreamRunId: string,
  decision: DreamDecision
): Promise<unknown> {
  try {
    return await getTrpc().dream.decide.mutate({ decision, dreamRunId });
  } finally {
    // The Needs you card of this batch is gone or stale either way.
    window.dispatchEvent(new Event(RAIL_REFRESH_EVENT));
  }
}

/** A team dream applies at once, so there is no batch to decide. */
function decideNothing(): Promise<void> {
  return Promise.resolve();
}

/**
 * The shared body of the agent and team dream hooks: the reads, the running
 * poll, the stale-reply guard and the actions.
 */
function useDreamRuns(
  source: DreamSource,
  onChanged: () => Promise<void>
): DreamApi {
  const { id, decide: decideRun, list, start } = source;
  const [runs, setRuns] = useState<DreamRun[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState<DreamPending | null>(null);
  // The agent or team the data on screen belongs to, so a slow reply for another one is dropped.
  const current = useRef(id);
  current.current = id;

  const reload = useCallback(async () => {
    try {
      const next = await list();
      if (current.current === id) {
        setRuns(next);
      }
    } catch (cause) {
      if (current.current === id) {
        setError(errorMessage(cause));
      }
    }
  }, [id, list]);

  useEffect(() => {
    setRuns(undefined);
    setError(undefined);
    reload();
  }, [reload]);

  // A dream that is still running changes on its own, so ask again until it ends.
  const running = runs?.some((run) => run.status === "running") ?? false;
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(reload, RUNNING_POLL_MS);
    return () => clearInterval(timer);
  }, [reload, running]);

  /** Runs one action, shows why it failed, and reads everything again either way. */
  const act = useCallback(
    async (kind: DreamPending, change: () => Promise<unknown>) => {
      setError(undefined);
      setPending(kind);
      try {
        await change();
      } catch (cause) {
        setError(errorMessage(cause));
      }
      await Promise.all([reload(), onChanged()]);
      setPending(null);
    },
    [onChanged, reload]
  );

  const runNow = useCallback(() => {
    act("run", start);
  }, [act, start]);

  const undo = useCallback(
    (dreamRunId: string) => {
      act("undo", () => getTrpc().dream.undo.mutate({ dreamRunId }));
    },
    [act]
  );

  const decide = useCallback(
    (dreamRunId: string, decision: DreamDecision) => {
      act(decision, () => decideRun(dreamRunId, decision));
    },
    [act, decideRun]
  );

  return { decide, error, pending, runNow, runs, undo };
}

/**
 * The dreams of one agent. `onChanged` runs after a dream or an undo has
 * changed the notes, so the rest of the tab reads them again.
 */
export function useDream(
  agentId: string,
  onChanged: () => Promise<void>
): DreamApi {
  const list = useCallback(
    () => getTrpc().dream.list.query({ agentId }),
    [agentId]
  );
  const start = useCallback(
    () => getTrpc().dream.runNow.mutate({ agentId }),
    [agentId]
  );
  return useDreamRuns(
    { decide: decideAgentDream, id: agentId, list, start },
    onChanged
  );
}

/**
 * The dreams of one team. A team dream applies at once, so the card never
 * holds a batch to decide. `onChanged` works as in `useDream`.
 */
export function useTeamDream(
  teamId: string,
  onChanged: () => Promise<void>
): DreamApi {
  const list = useCallback(
    () => getTrpc().dream.listTeam.query({ teamId }),
    [teamId]
  );
  const start = useCallback(
    () => getTrpc().dream.runTeamNow.mutate({ teamId }),
    [teamId]
  );
  return useDreamRuns(
    { decide: decideNothing, id: teamId, list, start },
    onChanged
  );
}
