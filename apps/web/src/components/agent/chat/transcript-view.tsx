import { useEffect, useRef } from "react";
import { Bubble, BubbleContent } from "#/components/ui/bubble.tsx";
import { Message, MessageContent } from "#/components/ui/message.tsx";
import type { FileInfo } from "#/integrations/trpc/types.ts";
import type { ChatItem } from "./chat-logic.ts";
import { FileChips } from "./file-chips.tsx";

function ToolItem({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  return (
    <details className="text-muted-foreground text-xs">
      <summary className="cursor-pointer">{item.label}</summary>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
        {item.detail}
      </pre>
    </details>
  );
}

function MessageItem({
  item,
  files,
}: {
  item: Extract<ChatItem, { kind: "user" | "assistant" }>;
  files: ReadonlyMap<string, FileInfo>;
}) {
  const align = item.kind === "user" ? "end" : "start";
  return (
    <Message align={align}>
      <MessageContent>
        {item.text === "" ? null : (
          <Bubble
            align={align}
            variant={item.kind === "user" ? "default" : "muted"}
          >
            <BubbleContent className="whitespace-pre-wrap">
              {item.text}
            </BubbleContent>
          </Bubble>
        )}
        {item.fileIds.length === 0 ? null : (
          <div
            className={
              item.kind === "user" ? "flex justify-end" : "flex justify-start"
            }
          >
            <FileChips fileIds={item.fileIds} files={files} />
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

export function TranscriptView({
  items,
  files,
}: {
  items: ChatItem[];
  files: ReadonlyMap<string, FileInfo>;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = items.length;

  useEffect(() => {
    if (count > 0) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [count]);

  if (items.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">Send a message to start.</p>
    );
  }

  return (
    <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
      {items.map((item) =>
        item.kind === "tool" ? (
          <ToolItem item={item} key={item.id} />
        ) : (
          <MessageItem files={files} item={item} key={item.id} />
        )
      )}
      <div ref={endRef} />
    </div>
  );
}
