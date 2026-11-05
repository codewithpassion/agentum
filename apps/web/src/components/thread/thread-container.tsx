import { ThreadPrimitive } from "@assistant-ui/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { StickyComposer } from "#/components/composer/sticky-composer.tsx";
import { requestIsVisible } from "../task/task-behaviour.ts";
import { AssistantMessageContainer } from "./assistant-message-container.tsx";
import { UserEditComposerContainer } from "./user-edit-composer-container.tsx";
import { UserMessageContainer } from "./user-message-container.tsx";

/**
 * The message list, scrolled to the newest message, with the composer under it.
 * The bottom padding holds the corners of a spinning "Working" icon. Without
 * it they stick out of the list as they turn, and the scrollbar flickers.
 */
export interface ThreadPosition {
  atBottom: boolean;
  jump: () => void;
  requestVisible: boolean;
  typing: boolean;
}

export function ThreadContainer({
  composer,
  earlier,
  runId,
  running,
  waiting,
}: {
  composer:
    | ReactNode
    | ((position: {
        atBottom: boolean;
        requestVisible: boolean;
        typing: boolean;
        jump: () => void;
      }) => ReactNode);
  earlier?: ReactNode;
  runId?: string;
  running?: boolean;
  waiting?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [requestVisible, setRequestVisible] = useState(true);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const root = viewport.current;
    if (root === null) {
      return;
    }
    const update = () => {
      setAtBottom(root.scrollHeight - root.scrollTop - root.clientHeight < 48);
      const card = root.querySelector('[data-request-pending="true"]');
      if (!card) {
        return;
      }
      const r = card.getBoundingClientRect();
      const v = root.getBoundingClientRect();
      setRequestVisible(requestIsVisible(r.top, r.bottom, v.top, v.bottom));
      setTyping(
        card.contains(document.activeElement) &&
          document.activeElement?.tagName === "INPUT"
      );
    };
    const observer = new MutationObserver(update);
    observer.observe(root, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    const resize = new ResizeObserver(update);
    resize.observe(root);
    root.addEventListener("scroll", update);
    root.addEventListener("focusin", update);
    root.addEventListener("focusout", update);
    update();
    return () => {
      observer.disconnect();
      resize.disconnect();
      root.removeEventListener("scroll", update);
      root.removeEventListener("focusin", update);
      root.removeEventListener("focusout", update);
    };
  }, []);
  const jump = () => {
    if (viewport.current !== null) {
      viewport.current.scrollTop = viewport.current.scrollHeight;
    }
  };
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
  const bottom =
    typeof composer === "function"
      ? composer({ atBottom, jump, requestVisible, typing })
      : composer;
  return (
    <ThreadPrimitive.Root className="flex h-full min-h-0 flex-col">
      <ThreadPrimitive.Viewport
        autoScroll={running && !waiting && atBottom}
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
      <div className="relative shrink-0 border-t px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:h-4 before:bg-gradient-to-t before:from-background before:to-transparent md:px-6">
        <div className="mx-auto max-w-[780px]">
          <StickyComposer background="bg-background">{bottom}</StickyComposer>
        </div>
      </div>
    </ThreadPrimitive.Root>
  );
}
