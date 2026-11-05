import { ThreadPrimitive } from "@assistant-ui/react";
import { type ReactNode, useEffect, useRef } from "react";
import { StickyComposer } from "#/components/composer/sticky-composer.tsx";
import { AssistantMessageContainer } from "./assistant-message-container.tsx";
import { UserEditComposerContainer } from "./user-edit-composer-container.tsx";
import { UserMessageContainer } from "./user-message-container.tsx";

/**
 * The message list, scrolled to the newest message, with the composer under it.
 * The bottom padding holds the corners of a spinning "Working" icon. Without
 * it they stick out of the list as they turn, and the scrollbar flickers.
 */
export function ThreadContainer({
  composer,
  earlier,
  runId,
  running,
  waiting,
}: {
  composer: ReactNode;
  earlier?: ReactNode;
  runId?: string;
  running?: boolean;
  waiting?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const root = viewport.current;
      if (root === null) {
        return;
      }
      if (running && !waiting) {
        root.scrollTop = root.scrollHeight;
        return;
      }
      const target = waiting
        ? root.querySelector('[data-request-pending="true"]')
        : document.getElementById(`thread-run-${runId}`);
      if (target) {
        root.scrollTop =
          target.getBoundingClientRect().top -
          root.getBoundingClientRect().top +
          root.scrollTop -
          (waiting ? 160 : 20);
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [runId, running, waiting]);
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Viewport
        autoScroll={running && !waiting}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-5 md:px-6 [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[780px]"
        ref={viewport}
        scrollToBottomOnInitialize={false}
        scrollToBottomOnRunStart={false}
        scrollToBottomOnThreadSwitch={false}
      >
        {earlier}
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
      <div className="shrink-0 border-t px-4 py-3 md:px-6">
        <div className="mx-auto max-w-[780px]">
          <StickyComposer background="bg-background">{composer}</StickyComposer>
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}
