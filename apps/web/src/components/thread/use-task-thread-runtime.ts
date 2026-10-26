import {
  type AppendMessage,
  type AssistantRuntime,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { ThreadMessage } from "@repo/protocol/thread";
import { useCallback, useMemo, useRef } from "react";
import { createAttachmentAdapter } from "./attachment-adapter.ts";
import { toThreadMessageLike } from "./thread-parts.ts";
import { fileIdsOfAppend, textOfAppend } from "./thread-send.ts";

export interface ThreadSendInput {
  fileIds: string[];
  text: string;
}

export interface ThreadEditInput extends ThreadSendInput {
  /** The id of the user message that is being edited. */
  messageId: string;
}

/**
 * The thread's assistant-ui runtime, on its external store: the messages come
 * from the task page's fold of the session events, and sending and editing are
 * the page's callbacks. It never reports the thread as running, because
 * assistant-ui would then disable the edit composer, and "Edit and resend"
 * has to work on a run that is still going. The composer disables itself from
 * the page's own run status instead.
 */
export const useTaskThreadRuntime = ({
  messages,
  onEdit,
  onError,
  onSend,
}: {
  messages: readonly ThreadMessage[];
  onEdit: (input: ThreadEditInput) => Promise<void>;
  onError: (cause: unknown) => void;
  onSend: (input: ThreadSendInput) => Promise<void>;
}): AssistantRuntime => {
  const adapter = useMemo(() => createAttachmentAdapter(), []);
  const runtimeRef = useRef<AssistantRuntime | null>(null);

  // A send that failed gives the text back to the composer.
  const failed = useCallback(
    (cause: unknown, text: string) => {
      runtimeRef.current?.thread.composer.setText(text);
      onError(cause);
    },
    [onError]
  );

  const onNew = useCallback(
    async (message: AppendMessage) => {
      const input = {
        fileIds: fileIdsOfAppend(message),
        text: textOfAppend(message),
      };
      try {
        await onSend(input);
      } catch (cause) {
        failed(cause, input.text);
      }
    },
    [failed, onSend]
  );

  const handleEdit = useCallback(
    async (message: AppendMessage) => {
      const { sourceId } = message;
      if (sourceId === null) {
        return;
      }
      try {
        await onEdit({
          fileIds: fileIdsOfAppend(message),
          messageId: sourceId,
          text: textOfAppend(message),
        });
      } catch (cause) {
        onError(cause);
      }
    },
    [onEdit, onError]
  );

  const runtime = useExternalStoreRuntime<ThreadMessage>({
    adapters: { attachments: adapter },
    convertMessage: toThreadMessageLike,
    isRunning: false,
    messages,
    onEdit: handleEdit,
    onNew,
  });
  runtimeRef.current = runtime;
  return runtime;
};
