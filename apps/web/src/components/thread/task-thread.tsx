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
import { getTrpc } from "#/integrations/trpc/client";
import type { TaskView } from "#/integrations/trpc/types";
import {
  bottomState,
  focusRequest,
  inputSourceKind,
  outsideLabel,
} from "../task/task-behaviour.ts";
import { BottomBar } from "./bottom-bar.tsx";
import { ComposerContainer } from "./composer-container.tsx";
import { addEditedMark, readEditedMarks } from "./edited-marks.ts";
import { ThreadContainer, type ThreadPosition } from "./thread-container.tsx";
import { type ThreadEnv, ThreadEnvProvider } from "./thread-context.tsx";
import { threadRequestViews } from "./thread-request-views.ts";
import {
  isActiveStatus,
  latestUserMessage,
  replyNote,
  startRunBody,
} from "./thread-send.ts";
import { useFileInfos } from "./use-file-infos.ts";
import {
  type ThreadEditInput,
  type ThreadSendInput,
  useTaskThreadRuntime,
} from "./use-task-thread-runtime.ts";

const noop = () => undefined;

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

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
  messages,
  nowMs,
  requests,
  task,
  inControl = false,
  canTake = false,
  onComputer,
  onFiles,
  onConflicts,
  routingHref: externalRoutingHref,
  filesText = "",
  stop,
  stopping = false,
  activeStatus,
}: {
  inControl?: boolean;
  canTake?: boolean;
  onComputer?: () => void;
  onFiles?: () => void;
  onConflicts?: () => void;
  routingHref?: string;
  filesText?: string;
  stop?: () => void;
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
  const starting = useRef<Promise<void> | null>(null);
  const [edited, setEdited] = useState<ReadonlySet<string>>(() => new Set());
  // Read after mount: the server render has no session storage.
  useEffect(() => setEdited(readEditedMarks()), []);

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
          label: `Run ${index + 1} of ${runs.length}${run.id === task.run.id ? " · this run" : ""} · ${run.createdAt.slice(11, 16)}`,
          runId: run.id,
        });
      }
    }
    return markers;
  }, [runs, visibleMessages, task.run.id]);
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
  const note = replyNote(task.session.origin);
  const latestRun = runs.at(-1);
  const latestMessage = messages.findLast(
    (message) => message.role === "assistant" && message.runId === latestRun?.id
  );
  const running = latestMessage
    ? isActiveStatus(latestMessage.status)
    : ["queued", "offered", "running", "waiting"].includes(
        latestRun?.status ?? ""
      );
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
                    `${label}${message.createdAt ? ` · ${message.createdAt.slice(11, 16)}` : ""}`,
                  ] as const,
                ];
          })
      ),
    [messages, task.startedBy]
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
            `${message.actorDisplay?.name ?? task.startedBy.label}${message.createdAt ? ` · ${message.createdAt.slice(11, 16)}` : ""}`,
          ])
      ),
    [messages, outsideLabels, task.startedBy.label]
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
      : "The run failed.";
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

  const startRun = useCallback(
    async ({ fileIds: ids, text }: ThreadSendInput, onStarted?: () => void) => {
      // One send at a time, so a second Ctrl+Enter cannot start a second run.
      if (starting.current !== null) {
        throw new Error("The last message is still being sent.");
      }
      const begin = async () => {
        await getTrpc().runs.start.mutate(
          startRunBody({
            agentId: task.agent.id,
            fileIds: ids,
            requestId: crypto.randomUUID(),
            session: task.session,
            text,
          })
        );
        onStarted?.();
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
    [navigate, router, task.agent.id, task.session]
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
      await startRun({ fileIds: ids, text }, () => addEditedMark(messageId));
    },
    [messages, startRun]
  );

  const onError = useCallback(
    (cause: unknown) => toast.error(messageOf(cause)),
    []
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
      requests: conversationRequests,
      requestTimes,
      runMarkers,
      viewedMessageIds,
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
      task.agent.name,
      runMarkers,
      viewedMessageIds,
    ]
  );

  const routingHrefs: Record<string, string> = {
    mail: "?tab=mail",
    trigger: "/triggers",
  };
  const routingHref = externalRoutingHref ?? routingHrefs[task.startedBy.kind];
  const renderBottom = useCallback(
    ({ atBottom, requestVisible, typing, jump }: ThreadPosition) => (
      <>
        <div className={state === "composer" ? "" : "hidden"}>
          <ComposerContainer
            disabledNote={state === "composer" ? null : "Reply when it is done"}
            nextRun={runs.length + 1}
          />
        </div>
        <BottomBar
          atBottom={atBottom}
          canStop={["running", "queued", "waiting", "offered"].includes(
            activeStatus ?? task.run.status
          )}
          onLatest={jump}
          onReview={review}
          onStop={stop ?? noop}
          origin={task.session.origin}
          pending={pending?.kind ?? null}
          requestVisible={requestVisible}
          routingHref={routingHref}
          runNumber={runs.length}
          state={state}
          stopping={stopping}
          typing={typing}
          workingLabel={workingLabel}
        />
      </>
    ),
    [
      state,
      runs.length,
      pending?.kind,
      review,
      stop,
      stopping,
      activeStatus,
      task.run.status,
      task.session.origin,
      routingHref,
      workingLabel,
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
