import { useEffect } from "react";
import type { ChannelEvent } from "#/modules/messaging/realtime";

const KNOWN_TYPES = new Set<ChannelEvent["type"]>([
  "agent.status",
  "message.created",
  "router.suppressed",
]);

const isChannelEvent = (value: unknown): value is ChannelEvent => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { type } = value as { type?: unknown };
  return (
    typeof type === "string" && KNOWN_TYPES.has(type as ChannelEvent["type"])
  );
};

/**
 * One socket per open channel. The Clerk session cookie rides the upgrade, so
 * no token plumbing is needed; the socket is torn down on channel switch.
 *
 * Events the client does not recognise are dropped rather than thrown on, so a
 * tab left open across a deploy keeps working.
 */
export const useChannelSocket = (
  channelId: string | null,
  onEvent: (event: ChannelEvent) => void
): void => {
  useEffect(() => {
    if (!channelId) {
      return;
    }

    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/api/channels/${channelId}/ws`
    );

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const parsed: unknown = JSON.parse(event.data);
      if (isChannelEvent(parsed)) {
        onEvent(parsed);
      }
    });

    return () => {
      socket.close();
    };
  }, [channelId, onEvent]);
};
