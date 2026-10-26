import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { ThreadMessage } from "@repo/protocol/thread";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type AnswerPayload,
  isConflict,
  type RequestView,
} from "#/components/requests/request-card-logic.ts";
import { getTrpc } from "#/integrations/trpc/client";
import type { TaskView } from "#/integrations/trpc/types";
import { ComposerContainer } from "./composer-container.tsx";
import { addEditedMark, readEditedMarks } from "./edited-marks.ts";
import { ThreadContainer } from "./thread-container.tsx";
import { type ThreadEnv, ThreadEnvProvider } from "./thread-context.tsx";
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

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const WORKING_NOTE =
  "The agent is working. You can send a message when it is done, or edit the last one to stop it and start over.";

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
 * session and moves to that run's task view.
 */
export function TaskThread({
  answer,
  messages,
  nowMs,
  requests,
  task,
}: {
  answer: (view: RequestView, payload: AnswerPayload) => Promise<void>;
  messages: readonly ThreadMessage[];
  nowMs: number | null;
  requests: ReadonlyMap<string, RequestView>;
  task: TaskView;
}) {
  const navigate = useNavigate();
  const starting = useRef<Promise<void> | null>(null);
  const [edited, setEdited] = useState<ReadonlySet<string>>(() => new Set());
  // Read after mount: the server render has no session storage.
  useEffect(() => setEdited(readEditedMarks()), []);

  const fileIds = useMemo(() => fileIdsOf(messages), [messages]);
  const { files } = useFileInfos(fileIds);
  const note = replyNote(task.session.origin);
  const running = messages.some(
    (message) => message.role === "assistant" && isActiveStatus(message.status)
  );

  const startRun = useCallback(
    async ({ fileIds: ids, text }: ThreadSendInput, onStarted?: () => void) => {
      // One send at a time, so a second Ctrl+Enter cannot start a second run.
      if (starting.current !== null) {
        return;
      }
      const begin = async () => {
        const result = await getTrpc().runs.start.mutate(
          startRunBody({
            agentId: task.agent.id,
            fileIds: ids,
            requestId: crypto.randomUUID(),
            session: task.session,
            text,
          })
        );
        onStarted?.();
        await navigate({
          params: { runId: result.runId },
          to: "/tasks/$runId",
        });
      };
      starting.current = begin();
      try {
        await starting.current;
      } finally {
        starting.current = null;
      }
    },
    [navigate, task.agent.id, task.session]
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
    messages,
    onEdit: edit,
    onError,
    onSend: startRun,
  });

  const env = useMemo<ThreadEnv>(
    () => ({
      agentName: task.agent.name,
      answer,
      editableId: note === null ? latestUserMessage(messages) : null,
      edited,
      files,
      nowMs,
      requests,
    }),
    [answer, edited, files, messages, note, nowMs, requests, task.agent.name]
  );

  let disabledNote: string | null = null;
  if (note !== null) {
    disabledNote = note;
  } else if (running) {
    disabledNote = WORKING_NOTE;
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadEnvProvider value={env}>
        <ThreadContainer
          composer={<ComposerContainer disabledNote={disabledNote} />}
        />
      </ThreadEnvProvider>
    </AssistantRuntimeProvider>
  );
}
