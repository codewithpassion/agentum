import { Markdown } from "#/components/markdown/markdown";
import { Bubble, BubbleContent } from "#/components/ui/bubble";
import { Message, MessageContent } from "#/components/ui/message";
import { AssistantCard, outcomeLine } from "./cards";
import type { AssistantAgent, CardOutcome, Conversation } from "./types";

type Block = Conversation["messages"][number]["content"][number];
type ToolUse = Extract<Block, { type: "tool_use" }>;
type ToolResult = Extract<Block, { type: "tool_result" }>;
const FIRST_LETTER = /^./;
const titleOf = (name: string) =>
  name
    .replaceAll("_", " ")
    .replace(FIRST_LETTER, (letter) => letter.toUpperCase());
function resultSummary(content: string, agents: AssistantAgent[]): string {
  try {
    const result = JSON.parse(content);
    if (typeof result.saved === "boolean" || typeof result.run === "boolean") {
      return outcomeLine(result as CardOutcome, agents);
    }
    if (typeof result.text === "string") {
      return result.text.length > 120
        ? `${result.text.slice(0, 120)}…`
        : result.text;
    }
    if (result.error) {
      return String(result.error);
    }
  } catch {
    /* Older tool output can be plain text. */
  }
  return content.length > 120 ? `${content.slice(0, 120)}…` : content;
}
function ToolLine({
  use,
  result,
  agents,
}: {
  use: ToolUse;
  result?: ToolResult;
  agents: AssistantAgent[];
}) {
  return (
    <details className="rounded-lg border px-3 py-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground">
        {titleOf(use.name)}
        {result ? ` · ${resultSummary(result.content, agents)}` : " · Waiting"}
      </summary>
      <pre className="mt-3 whitespace-pre-wrap break-words text-xs">
        {JSON.stringify(use.input, null, 2)}
      </pre>
      {result ? (
        <pre className="mt-2 whitespace-pre-wrap break-words text-xs">
          {result.content}
        </pre>
      ) : null}
    </details>
  );
}
function TextMessage({
  text,
  role,
}: {
  text: string;
  role: "user" | "assistant";
}) {
  const failed =
    text === "The assistant could not finish this turn. Try again.";
  return (
    <Message align={role === "user" ? "end" : "start"}>
      <MessageContent>
        <span className="text-muted-foreground text-xs">
          {role === "user" ? "You" : "Assistant"}
        </span>
        <Bubble
          className="max-w-full"
          variant={role === "user" ? "outline" : "ghost"}
        >
          <BubbleContent className="overflow-visible">
            <div
              className={failed ? "text-destructive" : undefined}
              role={failed ? "alert" : undefined}
            >
              <Markdown>{text}</Markdown>
            </div>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}
export function AssistantMessages({
  conversation,
  agents,
  disabled,
  onResolve,
}: {
  agents: AssistantAgent[];
  conversation: Conversation;
  disabled: boolean;
  onResolve: (outcome: CardOutcome) => Promise<void>;
}) {
  const results = new Map(
    conversation.messages.flatMap((message) =>
      message.content.flatMap((block) =>
        block.type === "tool_result"
          ? [[block.tool_use_id, block] as const]
          : []
      )
    )
  );
  return conversation.messages.map((message) => (
    <div className="flex flex-col gap-3" key={message.id}>
      {message.content.map((block, index) => {
        if (block.type === "tool_result") {
          return null;
        }
        // The stored transcript is append-only; block positions never change.
        if (block.type === "text") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: Anthropic text blocks have no IDs and persisted positions are stable.
            <TextMessage key={index} role={message.role} text={block.text} />
          );
        }
        if (conversation.pendingCard?.toolUseId === block.id) {
          return (
            <AssistantCard
              agents={agents}
              card={conversation.pendingCard}
              disabled={disabled}
              key={block.id}
              onResolve={onResolve}
              recoveryKey={`${conversation.id}:${block.id}`}
            />
          );
        }
        return (
          <ToolLine
            agents={agents}
            key={block.id}
            result={results.get(block.id)}
            use={block}
          />
        );
      })}
    </div>
  ));
}
