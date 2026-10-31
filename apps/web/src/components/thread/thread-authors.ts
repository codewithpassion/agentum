import type { ThreadMessage } from "@repo/protocol/thread";

const personKey = (message: ThreadMessage): string | null => {
  const { actor } = message;
  return actor && (actor.kind === "user" || actor.kind === "guest")
    ? `${actor.kind}:${actor.id}`
    : null;
};

/** Outside agents are labelled whoever else is in the thread, and are never numbered as people. */
const peerLabel = (name: string | undefined): string =>
  `${name || "Outside agent"} (outside agent)`;

const personLabel = (
  name: string | undefined,
  kind: string | undefined,
  ordinal: number | undefined
): string => {
  if (ordinal === undefined) {
    return "Unknown author";
  }
  return `${name || (kind === "guest" ? "Guest" : "Person")} · ${ordinal}`;
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
  const showPeople = multiPerson || people.size >= 2;
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    const name = message.actorDisplay?.name.trim();
    if (message.actor?.kind === "peer") {
      labels.set(message.id, peerLabel(name));
    } else if (showPeople) {
      const key = personKey(message);
      labels.set(
        message.id,
        personLabel(
          name,
          message.actor?.kind,
          key === null ? undefined : people.get(key)
        )
      );
    }
  }
  return labels;
};
