import { toActionLog } from "@repo/services/tasks/action-log";
import { buildReceipt } from "@repo/services/tasks/receipt";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import {
  type AnswerPayload,
  isConflict,
  type RequestView,
} from "#/components/requests/request-card-logic.ts";
import { TaskThread } from "#/components/thread/task-thread.tsx";
import {
  applyThreadFrame,
  initialThread,
  resetThread,
  type ThreadState,
} from "#/components/thread/thread-state.ts";
import { Button } from "#/components/ui/button.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { TaskView } from "#/integrations/trpc/types";
import { ActionLog } from "./action-log.tsx";
import { Receipt } from "./receipt.tsx";
import { ComputerSlot, FilesSlot, SlotCard } from "./slots.tsx";
import {
  canStop,
  costText,
  pendingTakeover,
  pillClass,
  receiptRunOf,
  runsOnText,
  splitOtherRuns,
  statusPill,
} from "./task-logic.ts";
import {
  applyFrame,
  applyPending,
  applySettled,
  applyTask,
  initialLive,
  isActive,
  lastEventId,
  requestViews,
  runEvents,
  type TaskLive,
} from "./task-state.ts";
import { ThreadRuns } from "./thread-runs.tsx";
import { useNowMs } from "./use-now-ms.ts";
import { useSessionEvents } from "./use-session-events.ts";

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type LiveAction =
  | { frame: Parameters<typeof applyFrame>[1]; kind: "frame" }
  | { kind: "pending"; records: Parameters<typeof applyPending>[1] }
  | {
      kind: "settled";
      requestId: string;
      settled: Parameters<typeof applySettled>[2];
    }
  | { kind: "task"; task: TaskView };

const reduceLive = (live: TaskLive, action: LiveAction): TaskLive => {
  switch (action.kind) {
    case "frame":
      return applyFrame(live, action.frame);
    case "pending":
      return applyPending(live, action.records);
    case "settled":
      return applySettled(live, action.requestId, action.settled);
    default:
      return applyTask(live, action.task);
  }
};

type ThreadAction =
  | { frame: Parameters<typeof applyFrame>[1]; kind: "frame" }
  | { events: TaskView["events"]; kind: "reset" };

const reduceThread = (state: ThreadState, action: ThreadAction): ThreadState =>
  action.kind === "frame"
    ? applyThreadFrame(state, action.frame)
    : resetThread(state, action.events);

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex max-w-full overflow-hidden rounded-md border text-xs">
      <b className="shrink-0 bg-muted px-2 py-0.5 font-medium font-mono text-[11px] text-muted-foreground">
        {label}
      </b>
      <span className="min-w-0 truncate bg-card px-2 py-0.5">{children}</span>
    </span>
  );
}

/**
 * One task, as a receipt of steps with the action log beside it. It starts
 * from `tasks.get` and follows the session stream, rebuilding the receipt and
 * the log from the event list on each event. The thread folds the same frames
 * (deltas included) into messages. The files slot reads the task folder itself.
 */
export function TaskPage({ initial }: { initial: TaskView }) {
  const runId = initial.run.id;
  const [task, setTask] = useState(initial);
  const [live, dispatch] = useReducer(reduceLive, initial, initialLive);
  const [thread, dispatchThread] = useReducer(
    reduceThread,
    initial.events,
    initialThread
  );
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const nowMs = useNowMs();

  const refetch = useCallback(async () => {
    try {
      const next = await getTrpc().tasks.get.query({ runId });
      setTask(next);
      dispatch({ kind: "task", task: next });
      dispatchThread({ events: next.events, kind: "reset" });
      setError(null);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [runId]);

  const getLastEventId = useCallback(() => lastEventId(live), [live]);
  const onFrame = useCallback((frame: Parameters<typeof applyFrame>[1]) => {
    dispatch({ frame, kind: "frame" });
    dispatchThread({ frame, kind: "frame" });
  }, []);
  useSessionEvents({
    lastEventId: getLastEventId,
    onFrame,
    refetch,
    sessionId: initial.session.id,
  });

  // A finished run has a cost and an end time the stream does not carry.
  const { runStatus } = live;
  const { finishedAt } = task.run;
  useEffect(() => {
    if (!isActive(runStatus) && finishedAt === null) {
      refetch();
    }
  }, [finishedAt, refetch, runStatus]);

  // A request the page has not heard of is in the pending list, not the events.
  const { needsRequests, sessionId } = live;
  useEffect(() => {
    if (needsRequests) {
      getTrpc()
        .requests.pending.query({ sessionId })
        .then((records) => dispatch({ kind: "pending", records }))
        .catch((cause: unknown) => setError(messageOf(cause)));
    }
  }, [needsRequests, sessionId]);

  const answer = useCallback(
    async (view: RequestView, payload: AnswerPayload) => {
      try {
        const record = await getTrpc().requests.answer.mutate({
          ...payload,
          requestId: view.id,
        });
        dispatch({
          kind: "settled",
          requestId: view.id,
          settled: {
            answer: record.answer ?? payload,
            answeredBy: record.answeredBy,
            status: "answered",
            via: "web",
          },
        });
      } catch (cause) {
        if (!isConflict(cause)) {
          throw cause;
        }
        dispatch({
          kind: "settled",
          requestId: view.id,
          settled: { status: "conflict" },
        });
      }
    },
    []
  );

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await getTrpc().runs.cancel.mutate({ runId });
      await refetch();
    } catch (cause) {
      // A run that ended meanwhile is what the person wanted.
      if (!isConflict(cause)) {
        setError(messageOf(cause));
      }
    } finally {
      setStopping(false);
    }
  }, [refetch, runId]);

  const events = useMemo(() => runEvents(live), [live]);
  const receiptRun = useMemo(
    () => receiptRunOf(task, runStatus),
    [task, runStatus]
  );
  const steps = useMemo(
    () => buildReceipt(receiptRun, events),
    [receiptRun, events]
  );
  const log = useMemo(() => toActionLog(events), [events]);
  const requests = useMemo(() => requestViews(live), [live]);
  const takeover = useMemo(() => pendingTakeover(requests), [requests]);
  const { earlier, later } = useMemo(
    () => splitOtherRuns(task.otherRuns, runId),
    [task.otherRuns, runId]
  );
  const pill = statusPill(runStatus);

  return (
    <section className="mx-auto flex max-w-6xl flex-col gap-4">
      <nav aria-label="Breadcrumb" className="text-muted-foreground text-sm">
        <Link to="/desk">Desk</Link> › Task
      </nav>
      <header className="flex flex-wrap items-center gap-2.5">
        <h1 className="min-w-60 flex-1 font-heading text-2xl text-foreground">
          {task.title}
        </h1>
        <span
          className={`rounded-full px-2.5 py-0.5 font-semibold text-xs ${pillClass(pill.tone)}`}
          data-testid="task-status"
        >
          {pill.text}
        </span>
        <Button
          disabled={stopping || !canStop(runStatus)}
          onClick={stop}
          size="sm"
          type="button"
          variant="outline"
        >
          Stop task
        </Button>
      </header>
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5" data-testid="task-facts">
        <Fact label="agent">
          <Link params={{ agentId: task.agent.id }} to="/agents/$agentId">
            {task.agent.name}
          </Link>
        </Fact>
        <Fact label="started by">{task.startedBy.label}</Fact>
        <Fact label="runs on">{runsOnText(task.agent)}</Fact>
        <Fact label="cost so far">{costText(task.run.costUsd)}</Fact>
      </div>
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[1_1_460px] flex-col gap-4">
          <Receipt
            agentName={task.agent.name}
            events={events}
            nowMs={nowMs}
            onAnswer={answer}
            requests={requests}
            steps={steps}
          />
        </div>
        <div className="flex min-w-0 flex-[1_1_380px] flex-col gap-4">
          <ThreadRuns heading="Earlier in this thread" runs={earlier} />
          <ThreadRuns heading="Later in this thread" runs={later} />
          <ComputerSlot
            agentName={task.agent.name}
            computerMachineId={task.agent.computerMachineId}
            takeover={takeover}
          />
          <FilesSlot runId={runId} running={isActive(runStatus)} />
          <ActionLog entries={log} />
          <SlotCard testId="slot-thread" title="Thread">
            <TaskThread
              answer={answer}
              messages={thread.messages}
              nowMs={nowMs}
              requests={requests}
              task={task}
            />
          </SlotCard>
        </div>
      </div>
    </section>
  );
}
