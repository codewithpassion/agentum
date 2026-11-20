import type { DreamDecision, DreamRun } from "@repo/db/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { getTrpc } from "#/integrations/trpc/client";
import { errorMessage } from "#/lib/error-message";

/** What the dream card waits for: a dream started here, or a night being undone. */
export type DreamPending = "run" | "undo" | DreamDecision;

/** One agent's dreams and the actions on them. */
export interface DreamApi {
  decide: (dreamRunId: string, decision: DreamDecision) => void;
  error: string | undefined;
  pending: DreamPending | null;
  runNow: () => void;
  /** Every dream of the agent, undefined until the first read. */
  runs: DreamRun[] | undefined;
  undo: (dreamRunId: string) => void;
}

/** How long a dream that is still running waits before the card asks again. */
export const RUNNING_POLL_MS = 3000;

/**
 * The dreams of one agent. `onChanged` runs after a dream or an undo has
 * changed the notes, so the rest of the tab reads them again.
 */
export function useDream(
  agentId: string,
  onChanged: () => Promise<void>
): DreamApi {
  const [runs, setRuns] = useState<DreamRun[] | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState<DreamPending | null>(null);
  // The agent the data on screen belongs to, so a slow reply for another agent is dropped.
  const current = useRef(agentId);
  current.current = agentId;

  const reload = useCallback(async () => {
    try {
      const next = await getTrpc().dream.list.query({ agentId });
      if (current.current === agentId) {
        setRuns(next);
      }
    } catch (cause) {
      if (current.current === agentId) {
        setError(errorMessage(cause));
      }
    }
  }, [agentId]);

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
    act("run", () => getTrpc().dream.runNow.mutate({ agentId }));
  }, [act, agentId]);

  const undo = useCallback(
    (dreamRunId: string) => {
      act("undo", () => getTrpc().dream.undo.mutate({ dreamRunId }));
    },
    [act]
  );

  const decide = useCallback(
    (dreamRunId: string, decision: DreamDecision) => {
      act(decision, () =>
        getTrpc().dream.decide.mutate({ decision, dreamRunId })
      );
    },
    [act]
  );

  return { decide, error, pending, runNow, runs, undo };
}
