import { useEffect } from "react";
import type { ChannelEvent } from "#/modules/messaging/realtime";
import type { MessageView } from "./api";

const isChannelEvent = (value: unknown): value is ChannelEvent =>
  typeof value === "object" &&
  value !== null &&
  (value as { type?: unknown }).type === "message.created";

/**
 * One socket per open channel. The Clerk session cookie rides the upgrade, so
 * no token plumbing is needed; the socket is torn down on channel switch.
 */
export const useChannelSocket = (
  channelId: string | null,
  onMessage: (message: MessageView) => void
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
        onMessage(parsed.message);
      }
    });

    return () => {
      socket.close();
    };
  }, [channelId, onMessage]);
};
