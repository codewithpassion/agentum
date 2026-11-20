import type { ArtifactCard } from "@repo/protocol/artifacts";
import { useCallback, useEffect, useState } from "react";
import {
  startPolling,
  usePolledQuery,
} from "#/components/inbox/use-polled-query.ts";
import { getTrpc } from "#/integrations/trpc/client.ts";
import type { TaskView } from "#/integrations/trpc/types.ts";
import type { MadeFile } from "./made-today.tsx";
import {
  activeRun,
  runsSignature,
  type TaskListItem,
  todaysRuns,
} from "./now-logic.ts";

export const LIVE_POLL_MS = 3000;
export const MADE_TODAY_POLL_MS = 15_000;
export const TASK_LIST_LIMIT = 50;

export interface LiveWork {
  error: string | null;
  refresh: () => Promise<void>;
  /** The active run read in full, or null when nothing is running. */
  task: TaskView | null;
  /** Newest first. */
  tasks: TaskListItem[];
}

interface LiveSnapshot {
  task: TaskView | null;
  tasks: TaskListItem[];
}

const loadLive = async (agentId: string): Promise<LiveSnapshot> => {
  const trpc = getTrpc();
  const tasks = await trpc.tasks.list.query({
    agentId,
    limit: TASK_LIST_LIMIT,
  });
  const active = activeRun(tasks);
  if (active === null) {
    return { task: null, tasks };
  }
  const view = await trpc.tasks.get.query({ runId: active.id });
  return { task: view.run === null ? null : view, tasks };
};

/** Polls the agent's tasks every LIVE_POLL_MS and reads the active one in full. */
export function useLiveWork({
  agentId,
  initialTasks,
}: {
  agentId: string;
  initialTasks: TaskListItem[];
}): LiveWork {
  const load = useCallback(() => loadLive(agentId), [agentId]);
  const { data, error, refresh } = usePolledQuery<LiveSnapshot>(
    load,
    { task: null, tasks: initialTasks },
    LIVE_POLL_MS
  );
  return {
    error,
    refresh,
    task: data?.task ?? null,
    tasks: data?.tasks ?? initialTasks,
  };
}

export interface MadeTodayData {
  artifacts: ArtifactCard[];
  files: MadeFile[];
}

interface RunMade {
  artifacts: ArtifactCard[];
  files: MadeFile[];
}

const EMPTY_MADE_TODAY: MadeTodayData = { artifacts: [], files: [] };

/** Follows the `next` cursors so every artifact of the run is listed. */
const loadRunArtifacts = async (
  runId: string,
  cursor?: string,
  cards: ArtifactCard[] = []
): Promise<ArtifactCard[]> => {
  const page = await getTrpc().artifacts.list.query({
    runId,
    ...(cursor === undefined ? {} : { cursor }),
  });
  cards.push(...page.items);
  return page.next === undefined
    ? cards
    : loadRunArtifacts(runId, page.next, cards);
};

const loadRunMade = async (runId: string): Promise<RunMade> => {
  const [folder, artifacts] = await Promise.all([
    getTrpc().tasks.files.query({ runId }),
    loadRunArtifacts(runId),
  ]);
  const files = folder.entries
    .filter((entry) => entry.kind === "file")
    .map((entry) => ({ path: entry.path, runId, size: entry.size }));
  return { artifacts, files };
};

/** Reads the runs one by one in parallel. A run whose read fails contributes nothing. */
const loadMadeToday = async (
  runIds: readonly string[]
): Promise<MadeTodayData> => {
  const settled = await Promise.allSettled(runIds.map(loadRunMade));
  const artifacts = new Map<string, ArtifactCard>();
  const files = new Map<string, MadeFile>();
  for (const result of settled) {
    if (result.status === "rejected") {
      continue;
    }
    for (const file of result.value.files) {
      files.set(file.path, file);
    }
    for (const card of result.value.artifacts) {
      artifacts.set(card.artifactId, card);
    }
  }
  return { artifacts: [...artifacts.values()], files: [...files.values()] };
};

/**
 * The files and artifacts of today's runs. Reads again when a run starts or
 * changes status, and every MADE_TODAY_POLL_MS while one is running.
 */
export function useMadeToday({
  nowMs,
  running,
  tasks,
}: {
  nowMs: number | null;
  running: boolean;
  tasks: readonly TaskListItem[];
}): MadeTodayData {
  const [made, setMade] = useState<MadeTodayData>(EMPTY_MADE_TODAY);
  // The time is read here and not taken from `nowMs`, so a page left open past midnight moves on to the new day.
  const runs = nowMs === null ? [] : todaysRuns(tasks, Date.now());
  // Every poll returns new task objects, so the runs are kept until their
  // signature changes. The effect then restarts only when a run starts or changes.
  const [readRuns, setReadRuns] = useState<readonly TaskListItem[]>(runs);
  if (runsSignature(readRuns) !== runsSignature(runs)) {
    setReadRuns(runs);
  }

  useEffect(() => {
    let current = true;
    let started = 0;
    const load = async () => {
      // A slow read must not land over a newer one.
      started += 1;
      const mine = started;
      const next = await loadMadeToday(readRuns.map((run) => run.id));
      if (current && mine === started) {
        setMade(next);
      }
    };
    load();
    if (!running) {
      return () => {
        current = false;
      };
    }
    const stop = startPolling(load, MADE_TODAY_POLL_MS);
    return () => {
      current = false;
      stop();
    };
  }, [readRuns, running]);

  return made;
}
