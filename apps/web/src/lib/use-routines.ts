import { useCallback, useEffect, useState } from "react";
import type { Routine, RoutineRun } from "./api";
import { useApi } from "./workspace-context";

/** What `GET /routines/:id` returns in one page, and the paging step after it. */
const RUNS_PAGE = 20;

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

export interface RoutinesState {
  error: string | null;
  reload: () => Promise<void>;
  routines: Routine[];
}

/** The list is small and is refetched after any mutation, like skills. */
export const useRoutines = (enabled: boolean): RoutinesState => {
  const api = useApi();
  const [routines, setRoutines] = useState<Routine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) {
      return;
    }
    try {
      setRoutines(await api.listRoutines());
      setError(null);
    } catch (cause) {
      setError(messageOf(cause, "Failed to load routines."));
    }
  }, [api, enabled]);

  useEffect(() => {
    reload();
  }, [reload]);

  return { error, reload, routines };
};

export interface RoutineDetailState {
  error: string | null;
  loading: boolean;
  /** Null while the next page is in flight is not a thing - this is the button. */
  loadMore: (() => Promise<void>) | null;
  reload: () => Promise<void>;
  routine: Routine | null;
  /** Newest first, oldest appended as history is paged in. */
  runs: RoutineRun[];
}

/**
 * One routine and its history. The first page rides along with the routine;
 * older runs are fetched with the `before` cursor, which is why `loadMore` is
 * null exactly when there is nothing older to fetch.
 */
export const useRoutineDetail = (
  id: string | null,
  enabled: boolean
): RoutineDetailState => {
  const api = useApi();
  const [routine, setRoutine] = useState<Routine | null>(null);
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!(enabled && id)) {
      return;
    }
    setLoading(true);
    try {
      const detail = await api.getRoutine(id);
      setRoutine(detail.routine);
      setRuns(detail.runs);
      // The server pages at 20; a full page is the only reason to think there
      // is a page after it.
      setNextBefore(
        detail.runs.length === RUNS_PAGE
          ? (detail.runs.at(-1)?.firedAt ?? null)
          : null
      );
      setError(null);
    } catch (cause) {
      setRoutine(null);
      setError(messageOf(cause, "Failed to load this routine."));
    } finally {
      setLoading(false);
    }
  }, [api, enabled, id]);

  // Switching routines must not leave the previous one's runs on screen.
  useEffect(() => {
    setRoutine(null);
    setRuns([]);
    setNextBefore(null);
    reload();
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (!id || nextBefore === null) {
      return;
    }
    try {
      const page = await api.listRoutineRuns(id, {
        before: nextBefore,
        limit: RUNS_PAGE,
      });
      setRuns((previous) => [...previous, ...page.runs]);
      setNextBefore(page.nextBefore);
    } catch (cause) {
      setError(messageOf(cause, "Failed to load older runs."));
    }
  }, [api, id, nextBefore]);

  return {
    error,
    loading,
    loadMore: nextBefore === null ? null : loadMore,
    reload,
    routine,
    runs,
  };
};
