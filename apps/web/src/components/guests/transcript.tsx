/** biome-ignore-all lint/suspicious/noArrayIndexKey: Immutable stored message parts have no separate IDs. */
/** biome-ignore-all lint/style/noNestedTernary: Read-only transcript renders only text and approval notices. */
import type { GuestSessionResult } from "@repo/protocol/guest";
import { foldThread, type ThreadEvent } from "@repo/protocol/thread";
import { useEffect, useState } from "react";
import { guestHttp } from "./http";
import type { GuestServices } from "./services";
/** Read-only transcript. No member navigation, file lookup or approval actions. */
export function GuestTranscript({
  services,
  failed,
}: {
  services: GuestServices;
  failed: (message: string) => void;
}) {
  const [events, setEvents] = useState<ThreadEvent[]>([]);
  useEffect(() => {
    let disposed = false;
    let after = "";
    const refresh = async () => {
      try {
        const result = await guestHttp.json<GuestSessionResult>(
          `${services.endpoint("session")}${after ? `?after=${encodeURIComponent(after)}` : ""}`
        );
        if (disposed) {
          return;
        }
        const entries = result.events.map((event) => ({
          ...event,
          payload: event.payload as Record<string, unknown>,
        }));
        after = entries.at(-1)?.id ?? after;
        setEvents((old) => [...old, ...entries]);
      } catch (cause) {
        if (!disposed) {
          failed(
            cause instanceof Error ? cause.message : "Transcript unavailable"
          );
        }
      }
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [services, failed]);
  return (
    <section aria-label="Shared agent transcript">
      <h2>Agent thread</h2>
      {foldThread(events).map((message) => (
        <article key={message.id}>
          <strong>{message.actorDisplay?.name ?? message.role}</strong>
          {message.parts.map((part, index) =>
            part.type === "text" ? (
              <p key={`${message.id}-${index}`}>{part.text}</p>
            ) : part.type === "request" ? (
              <p key={part.requestId}>
                A workspace member must answer this request.
              </p>
            ) : null
          )}
        </article>
      ))}
      {events.length === 0 && <p>No messages yet.</p>}
    </section>
  );
}
