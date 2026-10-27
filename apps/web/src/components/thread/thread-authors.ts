import type { ThreadMessage } from "@repo/protocol/thread";

const personKey = (message: ThreadMessage): string | null => {
  const { actor } = message;
  return actor && (actor.kind === "user" || actor.kind === "guest")
    ? `${actor.kind}:${actor.id}`
    : null;
};

/** Names come only from the trusted adapter, never message text or payloads.
 * Stable per-person ordinals distinguish missing or duplicate display names.
 */
export const threadAuthorLabels = (
  messages: readonly ThreadMessage[],
  multiPerson = false
): ReadonlyMap<string, string> => {
  const people = new Map<string, number>();
  for (const message of messages) {
    const key = message.role === "user" ? personKey(message) : null;
    if (key !== null && !people.has(key)) {
      people.set(key, people.size + 1);
    }
  }
  const labels = new Map<string, string>();
  if (!multiPerson && people.size < 2) {
    return labels;
  }
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const key = personKey(message);
    const ordinal = key === null ? undefined : people.get(key);
    const name = message.actorDisplay?.name.trim();
    labels.set(
      message.id,
      ordinal === undefined
        ? "Unknown author"
        : `${name || (message.actor?.kind === "guest" ? "Guest" : "Person")} · ${ordinal}`
    );
  }
  return labels;
};
