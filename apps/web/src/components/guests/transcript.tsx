/** biome-ignore-all lint/suspicious/noArrayIndexKey: Immutable stored message parts have no separate IDs. */
/** biome-ignore-all lint/style/noNestedTernary: Read-only transcript renders only text and approval notices. */

import type { GuestSessionResult } from "@repo/protocol/guest";
import { foldThread, type ThreadEvent } from "@repo/protocol/thread";
import { useEffect, useState } from "react";
import { startPolling } from "#/components/inbox/use-polled-query";
import { errorMessage } from "#/lib/error-message";
import { guestHttp } from "./http";
import type { GuestServices } from "./services";
import { consumeGuestStream } from "./stream";
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
    let reading = false;
    let streaming = false;
    const abort = new AbortController();
    const seen = new Set<string>();
    const append = (entries: ThreadEvent[]) => {
      if (disposed) {
        return;
      }
      const fresh = entries.filter((event) => !seen.has(event.id));
      for (const event of fresh) {
        seen.add(event.id);
        if (event.id > after) {
          after = event.id;
        }
      }
      setEvents((old) =>
        [...old, ...fresh].sort((a, b) => a.id.localeCompare(b.id))
      );
    };
    const stream = async () => {
      if (streaming || disposed) {
        return;
      }
      streaming = true;
      try {
        // Release the rotating-cookie lock once response headers are received.
        // The authorized stream uses a stable server session reference thereafter.
        const response = await guestHttp.run(() => {
          if (disposed) {
            throw new Error("Disposed");
          }
          return guestHttp.response(
            `${services.stream}?after=${encodeURIComponent(after)}`,
            { signal: abort.signal }
          );
        });
        await consumeGuestStream(response, (frame) => {
          if (frame.frame === "event") {
            append([
              { ...frame, payload: "payload" in frame ? frame.payload : {} },
            ]);
          }
        });
      } catch {
        /* Reconnect from the last stored event on the next poll. */
      } finally {
        streaming = false;
      }
    };
    const page = async () => {
      const result = await guestHttp.json<GuestSessionResult>(
        `${services.endpoint("session")}${after ? `?after=${encodeURIComponent(after)}` : ""}`
      );
      if (disposed) {
        return result;
      }
      append(
        result.events.map((event) => ({
          ...event,
          payload: (event.payload ?? {}) as Record<string, unknown>,
        }))
      );
      return result;
    };
    const report = (cause: unknown) => {
      if (!disposed) {
        failed(errorMessage(cause, "Transcript unavailable"));
      }
    };
    const pages = async () => {
      let result = await page();
      while (result.events.length === 100 && !disposed) {
        // biome-ignore lint/performance/noAwaitInLoops: transcript pages follow their cursor.
        result = await page();
      }
      return result;
    };
    const refresh = async () => {
      if (reading || disposed) {
        return;
      }
      reading = true;
      try {
        const result = await pages();
        if (result.sessionId && !disposed) {
          stream();
        }
      } catch (cause) {
        report(cause);
      } finally {
        reading = false;
      }
    };
    refresh();
    const stop = startPolling(refresh, 3000);
    return () => {
      disposed = true;
      abort.abort();
      stop();
    };
  }, [services, failed]);
  return (
    <section aria-label="Shared agent transcript">
      <h2>Agent thread</h2>
      {foldThread(events).map((message) => (
        <article key={message.id}>
          <strong>{message.actorDisplay?.name ?? message.role}</strong>
          <p role="status">
            {message.status === "waiting"
              ? "Waiting for a workspace member to answer in Needs you."
              : message.status}
          </p>
          {message.parts.map((part, index) =>
            part.type === "text" ? (
              <p key={`${message.id}-${index}`}>{part.text}</p>
            ) : part.type === "request" ? (
              <p key={part.requestId}>
                {part.status === "pending"
                  ? "Waiting for a workspace member to answer in Needs you."
                  : `Member request ${part.status}.`}
              </p>
            ) : null
          )}
        </article>
      ))}
      {events.length === 0 && <p>No messages yet.</p>}
    </section>
  );
}
