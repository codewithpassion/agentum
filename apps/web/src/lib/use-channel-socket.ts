import { useEffect } from "react";
import type { ChannelEvent } from "#/modules/messaging/realtime";
import { useApi } from "./workspace-context";

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
  const api = useApi();

  useEffect(() => {
    if (!channelId) {
      return;
    }

    const socket = new WebSocket(api.channelSocketUrl(channelId));

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
  }, [api, channelId, onEvent]);
};
