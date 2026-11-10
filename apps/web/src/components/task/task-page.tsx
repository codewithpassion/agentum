import { toActionLog } from "@repo/services/tasks/action-log";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { ArtifactsSlot } from "#/components/artifacts/list/artifacts-slot.tsx";
import { useKeyboardInset } from "#/components/composer/sticky-composer.tsx";
import { canTakeOver } from "#/components/computer/desktop-status.ts";
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
import { SidebarTrigger } from "#/components/ui/sidebar.tsx";
import { getTrpc } from "#/integrations/trpc/client";
import type { TaskView } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { ActionLog } from "./action-log.tsx";
import { withRun } from "./load-task.ts";
import { MailSlot } from "./mail-slot.tsx";
import { FilesSlot, TaskComputerPanel, useTaskFiles } from "./slots.tsx";
import {
  filesSummary,
  focusRequest,
  taskStatus,
  totalFiles,
} from "./task-behaviour.ts";
import { usePublishTaskControl } from "./task-control.ts";
import {
  canStop,
  costText,
  pendingTakeover,
  pillClass,
  runsOnText,
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
import { RequestBanner, type TaskTab, TaskTabs } from "./task-tabs.tsx";
import { ThreadRelatives } from "./thread-relatives.tsx";
import { RunPicker, sessionRuns } from "./thread-runs.tsx";
import { ThreadTitle } from "./thread-title.tsx";
import { useNowMs } from "./use-now-ms.ts";
import { useSessionEvents } from "./use-session-events.ts";
import { useTaskComputer } from "./use-task-computer.ts";
import { useTaskMail } from "./use-task-mail.ts";

const messageOf = (cause: unknown): string => errorMessage(cause);

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

/** One run in the header and tabs, with the session conversation filling the pane. */
export function TaskPage({ initial }: { initial: TaskView }) {
  const keyboardInset = useKeyboardInset();
  const runId = initial.run.id;
  const sessionId = initial.session.id;
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
      const next = withRun(await getTrpc().tasks.get.query({ runId }));
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
  const { needsRequests } = live;
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
            ...(record.sendError === null
              ? {}
              : { sendError: record.sendError }),
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
  const { error: mailError, thread: mailThread } = useTaskMail(
    runId,
    task.agent.id,
    isActive(runStatus)
  );
  const log = useMemo(() => toActionLog(events), [events]);
  const requests = useMemo(() => requestViews(live), [live]);
  const takeover = useMemo(() => pendingTakeover(requests), [requests]);
  const runs = useMemo(
    () =>
      sessionRuns(task.otherRuns, {
        ...task.run,
        status: runStatus,
        title: task.title,
      }),
    [task, runStatus]
  );
  const number = runs.findIndex((run) => run.id === runId) + 1;
  const latest = runs.at(-1) as (typeof runs)[number];
  const [selected, setSelected] = useState<TaskTab>("conversation");
  const { files, error: filesError } = useTaskFiles({
    runId,
    running: isActive(runStatus),
  });
  const [artifacts, setArtifacts] = useState(0);
  const fileCount = totalFiles(files, artifacts);
  const pending = [...requests.values()].find(
    (request) => request.settled === null
  );
  const navigate = useNavigate();
  const search = useSearch({ from: "/_app/threads/$sessionId" });
  // The tab lives in the URL, so a reload or a shared link opens the same one.
  const selectTab = useCallback(
    (tab: TaskTab) => {
      setSelected(tab);
      navigate({
        hash: undefined,
        params: { sessionId },
        replace: true,
        resetScroll: false,
        search: {
          ...(search.run === undefined ? {} : { run: search.run }),
          ...(tab === "conversation" ? {} : { tab }),
        },
        to: "/threads/$sessionId",
      });
    },
    [navigate, search.run, sessionId]
  );
  const {
    split,
    desktopStatus,
    setDesktopStatus,
    inControl,
    dockWidth,
    selectComputer,
    closeComputer,
    openComputer,
    onFiles,
    onConflicts,
    computerClass,
  } = useTaskComputer({
    machineId: task.agent.computerMachineId,
    selected,
    selectTab,
    setSelected,
    startedBy: task.startedBy.kind,
  });
  usePublishTaskControl(inControl, task.agent.name, takeover?.requestId, runId);
  const review = useCallback(() => {
    selectTab("conversation");
    requestAnimationFrame(() => {
      focusRequest(pending?.id);
    });
  }, [selectTab, pending?.id]);

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      style={{ paddingBottom: keyboardInset }}
    >
      <TaskHeader
        error={error}
        inControl={inControl}
        keyboardOpen={keyboardInset > 80}
        onComputer={selectComputer}
        onError={setError}
        pending={pending !== undefined && !inControl}
        runStatus={runStatus}
        runs={runs}
        stop={stop}
        stopping={stopping}
        task={task}
      />
      <ThreadRelatives parent={task.parent} subThreads={task.children} />
      <TaskTabs
        computer={task.agent.computerMachineId !== null && dockWidth === null}
        conflict={(files?.conflicts.length ?? 0) > 0}
        files={fileCount}
        log={log.length}
        mail={
          task.startedBy.kind === "mail"
            ? (mailThread?.messages.length ?? 0)
            : null
        }
        onSelect={selectTab}
        pending={pending !== undefined && !inControl}
        selected={selected}
        takeover={pending?.kind === "takeover"}
      />
      {latest.id === runId ? null : (
        <div className="flex shrink-0 flex-wrap justify-between gap-1 border-info/40 border-b bg-info/10 px-4 py-2 text-info text-xs md:px-6">
          <span>
            Viewing run {number} of {runs.length}. Files and Log show this run.
          </span>
          <Link
            className="underline"
            params={{ sessionId }}
            search={{}}
            to="/threads/$sessionId"
          >
            Go to the latest run
          </Link>
        </div>
      )}
      <RequestBanner
        kind={inControl ? null : (pending?.kind ?? null)}
        onReview={review}
        selected={selected}
      />
      <div className="flex min-h-0 flex-1" ref={split}>
        <div
          className={
            selected === "computer" && dockWidth === null
              ? "hidden"
              : "flex min-w-0 flex-1 flex-col"
          }
        >
          <div
            aria-labelledby="task-tab-conversation"
            className={
              selected === "conversation" ? "min-h-0 flex-1" : "hidden"
            }
            id="task-panel-conversation"
            role="tabpanel"
          >
            <TaskThread
              activeStatus={runStatus}
              answer={answer}
              canTake={canTakeOver({
                hasTakeover: takeover !== null,
                status: desktopStatus,
              })}
              filesText={filesSummary(files, artifacts)}
              inControl={inControl}
              messages={thread.messages}
              nowMs={nowMs}
              onComputer={openComputer}
              onConflicts={onConflicts}
              onFiles={onFiles}
              requests={requests}
              routingHref={
                mailThread
                  ? `/agents/${task.agent.id}?mail=${encodeURIComponent(mailThread.id)}`
                  : undefined
              }
              stop={stop}
              stopping={stopping}
              task={{ ...task, events: live.events }}
            />
          </div>
          <div
            aria-labelledby="task-tab-files"
            className={
              selected === "files"
                ? "min-h-0 flex-1 overflow-y-auto p-4 md:p-6"
                : "hidden"
            }
            id="task-panel-files"
            role="tabpanel"
          >
            <FilesSlot
              error={filesError}
              files={files}
              hasArtifacts={artifacts > 0}
              number={number}
            />
            <ArtifactsSlot
              onCount={setArtifacts}
              runId={runId}
              running={isActive(runStatus)}
            />
          </div>
          <div
            aria-labelledby="task-tab-log"
            className={
              selected === "log"
                ? "min-h-0 flex-1 overflow-y-auto p-4 md:p-6"
                : "hidden"
            }
            id="task-panel-log"
            role="tabpanel"
          >
            <p className="mb-3 text-muted-foreground text-sm">
              Log of run {number} · every event, oldest first
            </p>
            <ActionLog entries={log} />
          </div>
          {task.startedBy.kind === "mail" ? (
            <div
              aria-labelledby="task-tab-mail"
              className={
                selected === "mail"
                  ? "min-h-0 flex-1 overflow-y-auto p-4 md:p-6"
                  : "hidden"
              }
              id="task-panel-mail"
              role="tabpanel"
            >
              <MailSlot
                agentId={task.agent.id}
                error={mailError}
                thread={mailThread}
              />
            </div>
          ) : null}
        </div>
        <TaskComputerPanel
          agentName={task.agent.name}
          className={computerClass}
          machineId={task.agent.computerMachineId}
          onClose={closeComputer}
          onStatus={setDesktopStatus}
          takeover={takeover}
          width={dockWidth}
        />
      </div>
    </section>
  );
}

function TaskHeader({
  task,
  runStatus,
  onComputer,
  pending,
  runs,
  stopping,
  stop,
  error,
  inControl,
  keyboardOpen,
  onError,
}: {
  onError: (message: string) => void;
  keyboardOpen: boolean;
  inControl: boolean;
  task: TaskView;
  onComputer: () => void;
  runStatus: TaskView["run"]["status"];
  pending: boolean;
  runs: ReturnType<typeof sessionRuns>;
  stopping: boolean;
  stop: () => Promise<void>;
  error: string | null;
}) {
  const runId = task.run.id;
  const pill = taskStatus(runStatus, pending, inControl);
  return (
    <header className="shrink-0 border-b px-4 py-2.5 md:px-6 md:py-3">
      <nav
        aria-label="Breadcrumb"
        className="mb-1 hidden items-center gap-2 text-muted-foreground text-sm md:flex"
      >
        <SidebarTrigger className="hidden size-6 md:inline-flex" />
        <Link to="/desk">Desk</Link> › Thread
      </nav>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <ThreadTitle
          keyboardOpen={keyboardOpen}
          onError={onError}
          session={task.session}
        />
        <div
          className={`${keyboardOpen ? "hidden" : "flex"} h-10 w-full items-center gap-2 md:flex md:h-auto md:w-auto`}
        >
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 border border-current px-2.5 py-1 font-medium text-xs ${pillClass(pill.tone)}`}
            data-testid="task-status"
          >
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-current"
            />
            {pill.text}
          </span>
          <span className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground text-xs md:hidden">
            {runs.length > 1 && canStop(runStatus) ? null : (
              <span className="truncate">{task.agent.name} ·</span>
            )}
            <span className="shrink-0">
              {(task.run.startedAt ?? task.run.createdAt).slice(11, 16)}
              {task.run.costUsd === null
                ? ""
                : ` · ${costText(task.run.costUsd)}`}
            </span>
          </span>
          <div className="md:hidden">
            <RunPicker runId={runId} runs={runs} sessionId={task.session.id} />
          </div>
          {task.agent.computerMachineId === null ? null : (
            <Button
              className="hidden md:inline-flex"
              id="task-computer-toggle"
              onClick={onComputer}
              size="sm"
              variant="outline"
            >
              Computer
            </Button>
          )}
          {canStop(runStatus) ? (
            <Button
              className="h-10 text-destructive md:h-8"
              disabled={stopping}
              onClick={stop}
              size="sm"
              type="button"
              variant="outline"
            >
              {stopping ? "Stopping…" : "Stop"}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="mt-1 hidden flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted-foreground md:flex">
        <Link
          className="text-foreground"
          params={{ agentId: task.agent.id }}
          to="/agents/$agentId"
        >
          {task.agent.name}
        </Link>
        <span>· Started by {task.startedBy.label}</span>
        <span>
          · {runsOnText(task.agent)}
          {inControl ? " · paused, you have control" : ""}
        </span>
        <span>
          · {(task.run.startedAt ?? task.run.createdAt).slice(11, 16)}
          {task.run.finishedAt && task.run.startedAt
            ? `, took ${Math.max(0, Math.round((Date.parse(task.run.finishedAt) - Date.parse(task.run.startedAt)) / 1000))}s`
            : ""}
        </span>
        <span>
          · {costText(task.run.costUsd)}{" "}
          {isActive(runStatus) ? "so far" : "this run"}
        </span>
        <RunPicker runId={runId} runs={runs} sessionId={task.session.id} />
      </div>
      {task.startedBy.parentRunId === undefined ? null : (
        <p className="mt-2 text-muted-foreground text-xs">
          {task.startedBy.label} · {task.run.model} ·{" "}
          <Link
            className="underline"
            params={{ runId: task.startedBy.parentRunId }}
            to="/tasks/$runId"
          >
            Parent task
          </Link>
        </p>
      )}
      {(task.subagents?.length ?? 0) === 0 ? null : (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-muted-foreground">Subagents</span>
          {task.subagents?.map((child) => (
            <Link
              className="underline"
              key={child.id}
              params={{ runId: child.id }}
              to="/tasks/$runId"
            >
              {child.title} · {child.model} · {child.status}
            </Link>
          ))}
        </div>
      )}
      {error === null ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}
