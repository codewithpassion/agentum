import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { ThreadMessage } from "@repo/protocol/thread";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type AnswerPayload,
  isConflict,
  type RequestView,
} from "#/components/requests/request-card-logic.ts";
import {
  earlierRunsLabel,
  sessionRuns,
} from "#/components/task/thread-runs.tsx";
import { Button } from "#/components/ui/button.tsx";
import { useViewer } from "#/hooks/use-viewer.ts";
import { getTrpc } from "#/integrations/trpc/client";
import type { TaskView } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { clockTime } from "#/lib/time.ts";
import {
  bottomState,
  focusRequest,
  inputSourceKind,
  outsideLabel,
} from "../task/task-behaviour.ts";
import { BottomBar } from "./bottom-bar.tsx";
import { ComposerContainer } from "./composer-container.tsx";
import { addEditedMark, readEditedMarks } from "./edited-marks.ts";
import { threadActivity, waitingMessages } from "./thread-activity.ts";
import { ThreadContainer, type ThreadPosition } from "./thread-container.tsx";
import { type ThreadEnv, ThreadEnvProvider } from "./thread-context.tsx";
import { threadRequestViews } from "./thread-request-views.ts";
import {
  busyNote,
  isActiveStatus,
  latestUserMessage,
  replyBody,
  replyNote,
  sendWhileWorkingBody,
  startRunBody,
} from "./thread-send.ts";
import { useFileInfos } from "./use-file-infos.ts";
import {
  type ThreadEditInput,
  type ThreadSendInput,
  useTaskThreadRuntime,
} from "./use-task-thread-runtime.ts";

const messageOf = (cause: unknown): string => errorMessage(cause);

/** The ids of the files the thread shows, so their names and sizes can be looked up. */
const fileIdsOf = (messages: readonly ThreadMessage[]): string[] => [
  ...new Set(
    messages.flatMap((message) =>
      message.parts.flatMap((part) =>
        part.type === "attachment" && "fileId" in part ? [part.fileId] : []
      )
    )
  ),
];

/**
 * The thread of a task: the session's messages on assistant-ui, with tool
 * cards, collapsed reasoning, files, the request cards, a composer and "Edit
 * and resend". The task page folds the session events and hands the messages
 * in, so the thread opens no stream of its own. A send starts a run in this
 * session and reloads the thread on its own URL.
 */
export function TaskThread({
  answer,
  messages: allMessages,
  nowMs,
  requests,
  task,
  inControl = false,
  canTake = false,
  onComputer,
  onFiles,
  onConflicts,
  onSent,
  routingHref: externalRoutingHref,
  filesText = "",
  stop,
  stopRun,
  stopping = false,
  activeStatus,
}: {
  inControl?: boolean;
  canTake?: boolean;
  onComputer?: () => void;
  onFiles?: () => void;
  onConflicts?: () => void;
  /** Called after a send in place of opening the thread's own URL, for a host that shows the thread itself. */
  onSent?: () => Promise<void>;
  routingHref?: string;
  filesText?: string;
  stop?: () => void;
  /** Stops a run of the session that is not the one on show, the one a message was sent into. */
  stopRun?: (runId: string) => void;
  stopping?: boolean;
  activeStatus?: TaskView["run"]["status"];
  answer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  messages: readonly ThreadMessage[];
  nowMs: number | null;
  requests: ReadonlyMap<string, RequestView>;
  task: TaskView;
}) {
  const navigate = useNavigate();
  const router = useRouter();
  const viewer = useViewer();
  const starting = useRef<Promise<void> | null>(null);
  const [edited, setEdited] = useState<ReadonlySet<string>>(() => new Set());
  // Read after mount: the server render has no session storage.
  useEffect(() => setEdited(readEditedMarks()), []);

  const activity = useMemo(() => threadActivity(task.events), [task.events]);
  // A message removed before its run started leaves the conversation.
  const messages = useMemo(
    () =>
      allMessages.filter(
        (message) =>
          message.runId === null || !activity.removed.has(message.runId)
      ),
    [allMessages, activity.removed]
  );
  const waiting = useMemo(
    () => waitingMessages(messages, activity),
    [messages, activity]
  );

  const runs = useMemo(
    () =>
      sessionRuns(task.otherRuns, {
        ...task.run,
        status: activeStatus ?? task.run.status,
        title: task.title,
      }),
    [task, activeStatus]
  );
  const earlier = runs.filter((run) => run.id < task.run.id);
  const [showEarlier, setShowEarlier] = useState(false);
  const folded = earlier.length >= 3 && !showEarlier;
  const visibleMessages = useMemo(
    () =>
      folded
        ? messages.filter(
            (message) => message.runId === null || message.runId >= task.run.id
          )
        : messages,
    [folded, messages, task.run.id]
  );
  const expandEarlier = useCallback(() => setShowEarlier(true), []);
  const runMarkers = useMemo(() => {
    const markers = new Map<string, { runId: string; label: string }>();
    if (runs.length < 2) {
      return markers;
    }
    for (const [index, run] of runs.entries()) {
      const first = visibleMessages.find((message) => message.runId === run.id);
      if (first) {
        markers.set(first.id, {
          label: `Task ${index + 1} of ${runs.length}${run.id === task.run.id ? " · this task" : ""} · ${clockTime(run.createdAt, viewer)}`,
          runId: run.id,
        });
      }
    }
    return markers;
  }, [runs, visibleMessages, task.run.id, viewer]);
  const viewedMessageIds = useMemo(
    () =>
      new Set(
        runs.at(-1)?.id === task.run.id
          ? []
          : messages
              .filter((message) => message.runId === task.run.id)
              .map((message) => message.id)
      ),
    [runs, messages, task.run.id]
  );
  const fileIds = useMemo(() => fileIdsOf(messages), [messages]);
  const { files } = useFileInfos(fileIds);
  const subThread =
    task.session.parentSessionId !== null && task.session.origin !== "artifact";
  const note = replyNote(task.session.origin, subThread);
  const latestRun = runs.at(-1);
  const latestMessage = messages.findLast(
    (message) => message.role === "assistant" && message.runId === latestRun?.id
  );
  const shownRunning = latestMessage
    ? isActiveStatus(latestMessage.status)
    : ["queued", "offered", "running", "waiting"].includes(
        latestRun?.status ?? ""
      );
  // The page's run list is from when it loaded: the events say what works now.
  const running =
    shownRunning || activity.working !== null || activity.queued.length > 0;
  const conversationRequests = useMemo(
    () => threadRequestViews(task.events, requests),
    [task.events, requests]
  );
  const pending = [...conversationRequests.values()].find(
    (request) => request.settled === null
  );
  const state = bottomState({
    control: inControl,
    origin: task.session.origin,
    pending: pending?.kind ?? null,
    subThread,
    working: running,
  });
  const outsideLabels = useMemo(
    () =>
      new Map(
        messages
          .filter((message) => message.role === "user")
          .flatMap((message) => {
            const origin = inputSourceKind(
              message.actor?.kind,
              task.startedBy.kind
            );
            const label = outsideLabel(
              origin,
              message.actorDisplay?.name ?? task.startedBy.label
            );
            return label === null
              ? []
              : [
                  [
                    message.id,
                    `${label}${message.createdAt ? ` · ${clockTime(message.createdAt, viewer)}` : ""}`,
                  ] as const,
                ];
          })
      ),
    [messages, task.startedBy, viewer]
  );
  const memberLabels = useMemo(
    () =>
      new Map(
        messages
          .filter(
            (message) =>
              message.role === "user" && !outsideLabels.has(message.id)
          )
          .map((message) => [
            message.id,
            `${message.actorDisplay?.name ?? task.startedBy.label}${message.createdAt ? ` · ${clockTime(message.createdAt, viewer)}` : ""}`,
          ])
      ),
    [messages, outsideLabels, task.startedBy.label, viewer]
  );
  const lastAnswer = messages.findLast(
    (message) => message.role === "assistant" && message.runId === task.run.id
  );
  const failureEvent = task.events.findLast(
    (event) =>
      event.runId === task.run.id &&
      (event.type === "run.failed" || event.type === "run.interrupted")
  );
  const rawError =
    typeof failureEvent?.payload.error === "string"
      ? failureEvent.payload.error
      : "The task failed.";
  const currentTool = latestMessage?.parts.findLast(
    (part) => part.type === "tool-call" && part.ok === null
  );
  const workingLabel =
    currentTool?.type === "tool-call"
      ? [
          currentTool.name,
          typeof currentTool.input === "object" && currentTool.input !== null
            ? Object.values(currentTool.input)[0]
            : null,
        ]
          .filter((part) => typeof part === "string")
          .join(" · ")
      : undefined;
  const review = useCallback(() => focusRequest(pending?.id), [pending?.id]);

  const workingRunId = activity.working ?? runs.at(-1)?.id ?? task.run.id;
  const startRun = useCallback(
    async (
      { fileIds: ids, text }: ThreadSendInput,
      onStarted?: () => void,
      asNewTask = false
    ) => {
      // One send at a time, so a second Ctrl+Enter cannot start a second run.
      if (starting.current !== null) {
        throw new Error("The last message is still being sent.");
      }
      const begin = async () => {
        if (running && !asNewTask) {
          // The task keeps its page: the stream brings the message in, as Dom's or as a waiting one.
          await getTrpc().runs.sendWhileWorking.mutate(
            sendWhileWorkingBody({
              fileIds: ids,
              requestId: crypto.randomUUID(),
              runId: workingRunId,
              text,
            })
          );
          onStarted?.();
          return;
        }
        await (subThread
          ? getTrpc().runs.reply.mutate(
              replyBody({
                fileIds: ids,
                requestId: crypto.randomUUID(),
                sessionId: task.session.id,
                text,
              })
            )
          : getTrpc().runs.start.mutate(
              startRunBody({
                agentId: task.agent.id,
                fileIds: ids,
                requestId: crypto.randomUUID(),
                session: task.session,
                text,
              })
            ));
        onStarted?.();
        if (onSent !== undefined) {
          await onSent();
          return;
        }
        // The thread keeps its URL. A reply drops `?run=`, so the page shows the new run.
        await navigate({
          params: { sessionId: task.session.id },
          search: {},
          to: "/threads/$sessionId",
        });
        // From `?run=` the navigation reloads from cached data of the bare URL, so reload again.
        await router.invalidate();
      };
      starting.current = begin();
      try {
        await starting.current;
      } finally {
        starting.current = null;
      }
    },
    [
      navigate,
      onSent,
      router,
      running,
      subThread,
      task.agent.id,
      task.session,
      workingRunId,
    ]
  );

  const edit = useCallback(
    async ({ fileIds: ids, messageId, text }: ThreadEditInput) => {
      const source = messages.find((message) => message.id === messageId);
      const turn = messages.find(
        (message) =>
          message.role === "assistant" && message.runId === source?.runId
      );
      if (source?.runId && turn !== undefined && isActiveStatus(turn.status)) {
        try {
          await getTrpc().runs.cancel.mutate({ runId: source.runId });
        } catch (cause) {
          // A run that ended meanwhile is what the person wanted.
          if (!isConflict(cause)) {
            throw cause;
          }
        }
      }
      // The mark waits for the new run, so a failed start does not claim an edit.
      await startRun(
        { fileIds: ids, text },
        () => addEditedMark(messageId),
        true
      );
    },
    [messages, startRun]
  );

  const onError = useCallback(
    (cause: unknown) => toast.error(messageOf(cause)),
    []
  );

  const removeWaiting = useCallback(
    async (runId: string) => {
      try {
        await getTrpc().runs.cancel.mutate({ runId });
      } catch (cause) {
        // A run that started meanwhile is no longer waiting, and is stopped with Stop.
        if (!isConflict(cause)) {
          onError(cause);
        }
      }
    },
    [onError]
  );

  const runtime = useTaskThreadRuntime({
    messages: visibleMessages,
    onEdit: edit,
    onError,
    onSend: startRun,
  });

  const editedRuns = useMemo(
    () =>
      new Set(
        messages
          .filter((message) => edited.has(message.id) && message.runId !== null)
          .map((message) => message.runId as string)
      ),
    [messages, edited]
  );
  const requestTimes = useMemo(
    () =>
      new Map(
        task.events
          .filter((event) => event.type === "request.answered")
          .flatMap((event) =>
            typeof event.payload.requestId === "string"
              ? [[event.payload.requestId, event.createdAt] as const]
              : []
          )
      ),
    [task.events]
  );
  const env = useMemo<ThreadEnv>(
    () => ({
      active: running,
      agentName: task.agent.name,
      answer,
      canTake,
      editableId: note === null ? latestUserMessage(messages) : null,
      edited,
      editedRuns,
      failure:
        lastAnswer?.status === "failed"
          ? { error: rawError, messageId: lastAnswer.id }
          : undefined,
      files,
      filesLine:
        lastAnswer && lastAnswer.status !== "running" && filesText && onFiles
          ? {
              messageId: lastAnswer.id,
              onConflicts,
              onOpen: onFiles,
              text: filesText,
            }
          : undefined,
      inControl,
      memberLabels,
      nowMs,
      onComputer,
      outsideLabels,
      remember: { agentId: task.agent.id, sessionId: task.session.id },
      removeWaiting,
      requests: conversationRequests,
      requestTimes,
      runMarkers,
      viewedMessageIds,
      waiting,
    }),
    [
      answer,
      editedRuns,
      requestTimes,
      running,
      outsideLabels,
      memberLabels,
      inControl,
      canTake,
      onComputer,
      lastAnswer,
      rawError,
      filesText,
      onFiles,
      onConflicts,
      edited,
      files,
      messages,
      note,
      nowMs,
      conversationRequests,
      task.agent.id,
      task.agent.name,
      task.session.id,
      runMarkers,
      viewedMessageIds,
      waiting,
      removeWaiting,
    ]
  );

  const routingHrefs: Record<string, string> = {
    mail: "?tab=mail",
    trigger: "/triggers",
  };
  const routingHref = externalRoutingHref ?? routingHrefs[task.startedBy.kind];
  // The reply box stays open while a task works, in a conversation that takes replies here.
  const composerOpen =
    state === "composer" || (state === "working" && note === null);
  const sendNote =
    state === "working" ? busyNote(task.agent.runtime) : undefined;
  const stopWorking = useCallback(() => {
    if (activity.working !== null && activity.working !== task.run.id) {
      stopRun?.(activity.working);
      return;
    }
    stop?.();
  }, [activity.working, stop, stopRun, task.run.id]);
  const renderBottom = useCallback(
    ({ atBottom, requestVisible, typing, jump }: ThreadPosition) => (
      <>
        <BottomBar
          atBottom={atBottom}
          canStop={
            activity.working !== null ||
            ["running", "queued", "waiting", "offered"].includes(
              activeStatus ?? task.run.status
            )
          }
          onLatest={jump}
          onReview={review}
          onStop={stopWorking}
          origin={task.session.origin}
          pending={pending?.kind ?? null}
          replyBelow={composerOpen}
          requestVisible={requestVisible}
          routingHref={routingHref}
          runNumber={runs.length}
          state={state}
          stopping={stopping}
          typing={typing}
          workingLabel={workingLabel}
        />
        <div className={composerOpen ? "" : "hidden"}>
          <ComposerContainer
            busyNote={composerOpen ? sendNote : undefined}
            disabledNote={composerOpen ? null : "Reply when it is done"}
            nextRun={runs.length + 1}
          />
        </div>
      </>
    ),
    [
      state,
      runs.length,
      pending?.kind,
      review,
      stopWorking,
      stopping,
      activeStatus,
      activity.working,
      task.run.status,
      task.session.origin,
      routingHref,
      workingLabel,
      composerOpen,
      sendNote,
    ]
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadEnvProvider value={env}>
        <ThreadContainer
          composer={renderBottom}
          earlier={
            folded ? (
              <div className="flex items-center justify-between gap-2 border border-dashed px-3 text-muted-foreground text-sm">
                <span>{earlierRunsLabel(earlier)}</span>
                <Button onClick={expandEarlier} size="sm" variant="ghost">
                  Show
                </Button>
              </div>
            ) : null
          }
          runId={task.run.id}
          running={running}
          waiting={pending !== undefined}
        />
      </ThreadEnvProvider>
    </AssistantRuntimeProvider>
  );
}
