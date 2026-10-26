import { ThreadPrimitive } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { AssistantMessageContainer } from "./assistant-message-container.tsx";
import { UserEditComposerContainer } from "./user-edit-composer-container.tsx";
import { UserMessageContainer } from "./user-message-container.tsx";

/** The message list, scrolled to the newest message, with the composer under it. */
export function ThreadContainer({ composer }: { composer: ReactNode }) {
  return (
    <ThreadPrimitive.Root className="flex flex-col gap-3">
      <ThreadPrimitive.Viewport
        autoScroll
        className="flex max-h-[60vh] min-h-24 flex-col gap-4 overflow-y-auto"
      >
        <ThreadPrimitive.Empty>
          <p className="text-muted-foreground text-sm">
            Nothing in this thread yet.
          </p>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages
          components={{
            AssistantMessage: AssistantMessageContainer,
            UserEditComposer: UserEditComposerContainer,
            UserMessage: UserMessageContainer,
          }}
        />
      </ThreadPrimitive.Viewport>
      {composer}
    </ThreadPrimitive.Root>
  );
}
