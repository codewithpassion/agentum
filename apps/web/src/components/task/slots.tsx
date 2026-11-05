import { useEffect, useMemo, useState } from "react";
import {
  DesktopScreen,
  type TakeoverControls,
} from "#/components/computer/desktop-screen.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import { TaskFilesList, type TaskFilesView } from "./task-files.tsx";
import type { TakeoverRequest } from "./task-logic.ts";

/** How often the files slot reads the task folder again while the run is going. */
export const FILES_REFRESH_MS = 5000;

/**
 * The files slot of the task view: the task folder, the edits outside it and
 * the open conflicts. Library events never reach the session stream, so it
 * reads `tasks.files` on mount, every 5 s while the run is running, and once
 * more when the run stops running (the end frame flips `running`).
 */
export function useTaskFiles({
  runId,
  running,
}: {
  runId: string;
  running: boolean;
}) {
  const [files, setFiles] = useState<TaskFilesView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    const load = async () => {
      try {
        const next = await getTrpc().tasks.files.query({ runId });
        if (current) {
          setFiles(next);
          setError(null);
        }
      } catch (cause) {
        if (current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      }
    };
    load();
    if (!running) {
      return () => {
        current = false;
      };
    }
    const timer = setInterval(load, FILES_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [runId, running]);

  return { error, files };
}

export function FilesSlot({
  files,
  error,
  number,
  hasArtifacts,
}: {
  files: TaskFilesView | null;
  error: string | null;
  number: number;
  hasArtifacts: boolean;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid="slot-files">
      <h2 className="text-muted-foreground text-sm">Files from run {number}</h2>
      {error === null ? null : <p role="alert">{error}</p>}
      {files === null ? (
        <p className="text-muted-foreground text-sm">Loading files…</p>
      ) : (
        <TaskFilesList
          files={files}
          number={hasArtifacts ? undefined : number}
        />
      )}
    </section>
  );
}

/** The anchor of the computer slot: V6.8's Slack card links to `#computer`. */
export const COMPUTER_ANCHOR = "computer";

/** Take over, hand back and cancel for one open request, through the takeover router. */
const takeoverControls = ({
  reason,
  requestId,
}: TakeoverRequest): TakeoverControls => ({
  cancel: async () => {
    await getTrpc().takeover.cancel.mutate({ requestId });
  },
  handBack: async (note) => {
    await getTrpc().takeover.handBack.mutate({
      requestId,
      ...(note === "" ? {} : { note }),
    });
  },
  reason,
  take: async () => {
    await getTrpc().takeover.take.mutate({ requestId });
  },
});

/** The computer slot of the task view: the agent's live screen, when it has a computer. */
export function ComputerSlot({
  computerMachineId,
  agentName,
  takeover,
}: {
  agentName: string;
  computerMachineId: string | null;
  /** The run's pending takeover request, or null. */
  takeover: TakeoverRequest | null;
}) {
  const controls = useMemo(
    () => (takeover === null ? null : takeoverControls(takeover)),
    [takeover]
  );
  return (
    <section
      className="flex flex-col gap-3"
      data-testid="slot-computer"
      id={COMPUTER_ANCHOR}
    >
      <h2 className="font-medium">{agentName}'s computer</h2>
      {computerMachineId === null ? (
        <p className="text-muted-foreground text-sm">
          This agent has no computer.
        </p>
      ) : (
        <DesktopScreen
          key={computerMachineId}
          machineId={computerMachineId}
          takeover={controls}
        />
      )}
    </section>
  );
}
