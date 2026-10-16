import { useEffect, useRef } from "react";
import { Markdown } from "#/components/markdown/markdown.tsx";
import { Bubble, BubbleContent } from "#/components/ui/bubble.tsx";
import { Message, MessageContent } from "#/components/ui/message.tsx";
import type { FileInfo } from "#/integrations/trpc/types.ts";
import type { ChatItem } from "./chat-logic.ts";
import { FileChips } from "./file-chips.tsx";

function ToolSection({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="font-medium">{label}</p>
      <pre className="overflow-x-auto whitespace-pre-wrap">{text}</pre>
    </div>
  );
}

function ToolItem({ item }: { item: Extract<ChatItem, { kind: "tool" }> }) {
  const hasSections = item.input !== null || item.output !== null;
  return (
    <details
      className="rounded-md border border-border px-3 py-2 text-muted-foreground text-xs"
      data-testid="tool-card"
    >
      <summary className="cursor-pointer">{item.label}</summary>
      {hasSections ? (
        <div className="mt-2 flex flex-col gap-2">
          {item.input === null ? null : (
            <ToolSection label="Input" text={item.input} />
          )}
          {item.output === null ? null : (
            <ToolSection label="Output" text={item.output} />
          )}
        </div>
      ) : (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">
          {item.detail}
        </pre>
      )}
    </details>
  );
}

function MessageItem({
  item,
  files,
  agentName,
}: {
  item: Extract<ChatItem, { kind: "user" | "assistant" }>;
  files: ReadonlyMap<string, FileInfo>;
  agentName?: string;
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
            <BubbleContent
              className={
                item.kind === "user" ? "whitespace-pre-wrap" : undefined
              }
            >
              {item.kind === "user" ? (
                item.text
              ) : (
                <Markdown>{item.text}</Markdown>
              )}
            </BubbleContent>
          </Bubble>
        )}
        {item.fileIds.length === 0 ? null : (
          <div
            className={
              item.kind === "user" ? "flex justify-end" : "flex justify-start"
            }
          >
            <FileChips
              agentName={item.kind === "assistant" ? agentName : undefined}
              fileIds={item.fileIds}
              files={files}
            />
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

export function TranscriptView({
  items,
  files,
  agentName,
  empty = "Send a message to start.",
}: {
  items: ChatItem[];
  files: ReadonlyMap<string, FileInfo>;
  /** The agent whose output the assistant items show. Enables "Save to library" on their files. */
  agentName?: string;
  empty?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = items.length;

  useEffect(() => {
    if (count > 0) {
      endRef.current?.scrollIntoView({ block: "end" });
    }
  }, [count]);

  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">{empty}</p>;
  }

  return (
    <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
      {items.map((item) =>
        item.kind === "tool" ? (
          <ToolItem item={item} key={item.id} />
        ) : (
          <MessageItem
            agentName={agentName}
            files={files}
            item={item}
            key={item.id}
          />
        )
      )}
      <div ref={endRef} />
    </div>
  );
}
