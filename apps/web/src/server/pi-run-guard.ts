// Warns the agent when it repeats the same failing tool call. The streak logic is
// pure and lives in @repo/protocol/safeguards; this file adds the warning to the
// request messages Pi sends to the model. It works on those messages only, so it
// keeps no state: every later request carries the warning again, and a call Pi
// settles without running (bad arguments, unknown tool) counts like any other.
import type {
  Message,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  defineExtension,
  GenerationTask,
  hook,
} from "@earendil-works/pi-durable";
import {
  nextStreak,
  REPEAT_WARN_AT,
  repeatWarning,
  type Streak,
} from "@repo/protocol/safeguards";

/** The result with the warning as one more text part, after what the result already has. */
const withWarning = (
  message: ToolResultMessage,
  warning: string
): ToolResultMessage => ({
  ...message,
  content: [...message.content, { text: warning, type: "text" }],
});

/**
 * The messages with the repeat warning added to the third failed result of an
 * identical call in a row. Every other message is returned as the same object.
 */
export const warnRepeats = (
  messages: readonly Message[]
): readonly Message[] => {
  const calls = new Map<string, ToolCall>();
  let streak: Streak | undefined;
  return messages.map((message) => {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") {
          calls.set(part.id, part);
        }
      }
      return message;
    }
    if (message.role !== "toolResult") {
      return message;
    }
    const call = calls.get(message.toolCallId);
    if (!call) {
      return message;
    }
    streak = nextStreak(streak, {
      input: call.arguments,
      name: call.name,
      ok: !message.isError,
    });
    if (!streak || streak.count !== REPEAT_WARN_AT) {
      return message;
    }
    return withWarning(message, repeatWarning(streak.tool, streak.count));
  });
};

/** The extension that adds the repeat warning to every request Pi makes. */
export const repeatGuardExtension = () =>
  defineExtension({
    hooks: [
      hook(GenerationTask, {
        beforeRequest: ({ messages }) => {
          const warned = warnRepeats(messages);
          const changed = warned.some(
            (message, index) => message !== messages[index]
          );
          return changed ? { messages: warned } : undefined;
        },
      }),
    ],
    name: "repeat-guard",
  });
