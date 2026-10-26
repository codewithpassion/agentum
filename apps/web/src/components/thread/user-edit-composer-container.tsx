import {
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { type FormEvent, useCallback } from "react";
import { SendHint } from "#/components/composer/send-hint.tsx";
import { submitOnSendShortcut } from "#/components/composer/send-shortcut.ts";
import { Button } from "#/components/ui/button.tsx";
import { Message, MessageContent } from "#/components/ui/message.tsx";

/**
 * The edit form of the latest user message. Sending it stops the run if it is
 * still going and starts a new one in the same session. The old turn stays in
 * the thread, so the agent still remembers it, and the form says so.
 */
export function UserEditComposerContainer() {
  const empty = useAuiState(
    (state) => state.message.composer.text.trim() === ""
  );
  const blockEmpty = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      if (empty) {
        event.preventDefault();
      }
    },
    [empty]
  );
  return (
    <MessagePrimitive.Root data-role="user">
      <Message align="end">
        <MessageContent>
          <ComposerPrimitive.Root
            className="flex w-full flex-col gap-2 rounded-xl border bg-card p-3"
            onSubmit={blockEmpty}
          >
            <ComposerPrimitive.Input
              aria-label="Edit message"
              className="field-sizing-content max-h-48 min-h-16 w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              onKeyDown={submitOnSendShortcut}
              submitMode="none"
            />
            <p className="text-muted-foreground text-xs">
              This sends a new message and starts a new run. The agent still
              remembers the earlier message.
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <SendHint />
              <ComposerPrimitive.Cancel asChild>
                <Button size="sm" type="button" variant="outline">
                  Cancel
                </Button>
              </ComposerPrimitive.Cancel>
              <ComposerPrimitive.Send asChild>
                <Button disabled={empty} size="sm" type="submit">
                  Edit and resend
                </Button>
              </ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
        </MessageContent>
      </Message>
    </MessagePrimitive.Root>
  );
}
