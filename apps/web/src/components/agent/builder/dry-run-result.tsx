import type { StreamFrame } from "@repo/protocol/stream";
import { buildReceipt } from "@repo/services/tasks/receipt";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { bandClass } from "#/components/desk/desk-logic.ts";
import type { RequestView } from "#/components/requests/request-card-logic.ts";
import { withRun } from "#/components/task/load-task.ts";
import { Receipt } from "#/components/task/receipt.tsx";
import { receiptRunOf, statusPill } from "#/components/task/task-logic.ts";
import {
  applyFrame,
  applyTask,
  initialLive,
  lastEventId,
  runEvents,
  type TaskLive,
} from "#/components/task/task-state.ts";
import { useNowMs } from "#/components/task/use-now-ms.ts";
import { useSessionEvents } from "#/components/task/use-session-events.ts";
import { getTrpc } from "#/integrations/trpc/client";
import type { TaskView } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { wouldLines } from "./dry-run-logic.ts";

type LiveAction =
  | { frame: StreamFrame; kind: "frame" }
  | { kind: "task"; task: TaskView };

const reduceLive = (live: TaskLive, action: LiveAction): TaskLive =>
  action.kind === "frame"
    ? applyFrame(live, action.frame)
    : applyTask(live, action.task);

const messageOf = (cause: unknown): string => errorMessage(cause);

/** A dry run opens no requests, so the receipt has none to answer. */
const NO_REQUESTS: ReadonlyMap<string, RequestView> = new Map();
const noAnswer = (): Promise<void> => Promise.resolve();

function Following({ initial }: { initial: TaskView }) {
  const runId = initial.run.id;
  const [task, setTask] = useState(initial);
  const [live, dispatch] = useReducer(reduceLive, initial, initialLive);
  const [error, setError] = useState<string | null>(null);
  const nowMs = useNowMs();

  const refetch = useCallback(async () => {
    try {
      const next = withRun(await getTrpc().tasks.get.query({ runId }));
      setTask(next);
      dispatch({ kind: "task", task: next });
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [runId]);
  const getLastEventId = useCallback(() => lastEventId(live), [live]);
  const onFrame = useCallback(
    (frame: StreamFrame) => dispatch({ frame, kind: "frame" }),
    []
  );
  useSessionEvents({
    lastEventId: getLastEventId,
    onFrame,
    refetch,
    sessionId: initial.session.id,
  });

  const events = useMemo(() => runEvents(live), [live]);
  const steps = useMemo(
    () => buildReceipt(receiptRunOf(task, live.runStatus), events),
    [task, live.runStatus, events]
  );
  const would = useMemo(() => wouldLines(events), [events]);
  const pill = statusPill(live.runStatus);

  return (
    <div className="flex flex-col gap-3" data-testid="dry-run-result">
      <div className={`rounded-md px-3 py-1.5 text-xs ${bandClass(pill.tone)}`}>
        {pill.text}
      </div>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {would.length === 0 ? null : (
        <ul className="flex flex-col gap-1" data-testid="dry-run-would">
          {would.map((line, index) => (
            <li
              className={`rounded-md px-3 py-1.5 text-xs ${bandClass("waiting")}`}
              // The same line can repeat, and lines only ever append.
              // biome-ignore lint/suspicious/noArrayIndexKey: Append-only list.
              key={`${index}:${line}`}
            >
              {line}
            </li>
          ))}
        </ul>
      )}
      <Receipt
        agentName={task.agent.name}
        events={events}
        nowMs={nowMs}
        onAnswer={noAnswer}
        requests={NO_REQUESTS}
        steps={steps}
      />
    </div>
  );
}

/** Follows one dry run: `tasks.get` first, then the session stream, rendered as a receipt. */
export function DryRunResult({ runId }: { runId: string }) {
  const [task, setTask] = useState<TaskView | undefined>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setTask(undefined);
    setError(null);
    getTrpc()
      .tasks.get.query({ runId })
      .then((next) => {
        if (current) {
          setTask(withRun(next));
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setError(messageOf(cause));
        }
      });
    return () => {
      current = false;
    };
  }, [runId]);

  if (error !== null) {
    return (
      <p className="text-destructive text-sm" role="alert">
        {error}
      </p>
    );
  }
  if (task === undefined) {
    return (
      <p className="text-muted-foreground text-sm">Starting the dry run…</p>
    );
  }
  return <Following initial={task} key={runId} />;
}
