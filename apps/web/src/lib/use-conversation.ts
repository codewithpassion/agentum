import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentStatusEvent,
  ChannelEvent,
} from "#/modules/messaging/realtime";
import {
  type Channel,
  type ChannelMemberView,
  getChannel,
  listMessages,
  type MessageView,
} from "./api";
import { useChannelSocket } from "./use-channel-socket";

export type ReplyListener = (message: MessageView) => void;

/** The router's live view of the agents woken from this channel. */
export type AgentStatuses = Record<string, AgentStatusEvent>;

export interface Conversation {
  /** Keyed by agent id; only agents the router has reported on appear. */
  agentStatuses: AgentStatuses;
  channel: Channel | null;
  error: string | null;
  loading: boolean;
  loadOlder: () => Promise<void>;
  members: ChannelMemberView[];
  /** Merges a message from either the POST response or the socket. */
  mergeMessage: ReplyListener;
  /** Oldest first, ready to render top to bottom. */
  messages: MessageView[];
  nextCursor: string | null;
  /** Takes the fresh list channel settings gets back from an add/remove. */
  setMembers: (members: ChannelMemberView[]) => void;
  /** Lets an open thread panel receive replies from the channel socket. */
  subscribeToReplies: (listener: ReplyListener) => () => void;
  /** The channel's loop guard is closed: agents stay quiet until a human posts. */
  suppressed: boolean;
}

/**
 * Channel state for the centre pane: the message page, the members, and the
 * live socket. New messages arrive twice (the POST response and the broadcast),
 * so entries are merged by id; thread replies only bump their parent's count.
 */
export const useConversation = (channelId: string | null): Conversation => {
  const [channel, setChannel] = useState<Channel | null>(null);
  const [members, setMembers] = useState<ChannelMemberView[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatuses>({});
  const [suppressed, setSuppressed] = useState(false);
  const seenReplyIds = useRef(new Set<string>());
  const replyListeners = useRef(new Set<ReplyListener>());

  const subscribeToReplies = useCallback((listener: ReplyListener) => {
    replyListeners.current.add(listener);
    return () => {
      replyListeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    setAgentStatuses({});
    setSuppressed(false);

    if (!channelId) {
      setChannel(null);
      setMembers([]);
      setMessages([]);
      setNextCursor(null);
      return;
    }

    let cancelled = false;
    seenReplyIds.current = new Set();
    setLoading(true);

    (async () => {
      try {
        const [details, page] = await Promise.all([
          getChannel(channelId),
          listMessages(channelId),
        ]);
        if (cancelled) {
          return;
        }
        setChannel(details.channel);
        setMembers(details.members);
        setMessages([...page.messages].reverse());
        setNextCursor(page.nextCursor);
        setError(null);
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error ? cause.message : "Failed to load messages."
          );
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [channelId]);

  const loadOlder = useCallback(async () => {
    if (!(channelId && nextCursor)) {
      return;
    }
    const page = await listMessages(channelId, nextCursor);
    setMessages((previous) => [...[...page.messages].reverse(), ...previous]);
    setNextCursor(page.nextCursor);
  }, [channelId, nextCursor]);

  const merge = useCallback((message: MessageView) => {
    if (message.authorType !== "agent") {
      // A human back in the conversation is exactly what reopens a channel the
      // router suppressed, so the notice goes with them.
      setSuppressed(false);
    }
    if (message.threadParentId) {
      if (seenReplyIds.current.has(message.id)) {
        return;
      }
      seenReplyIds.current.add(message.id);
      const parentId = message.threadParentId;
      setMessages((previous) =>
        previous.map((entry) =>
          entry.id === parentId
            ? { ...entry, replyCount: entry.replyCount + 1 }
            : entry
        )
      );
      for (const listener of replyListeners.current) {
        listener(message);
      }
      return;
    }

    setMessages((previous) => {
      const index = previous.findIndex((entry) => entry.id === message.id);
      if (index === -1) {
        return [...previous, message];
      }
      const next = [...previous];
      next[index] = message;
      return next;
    });
  }, []);

  const onEvent = useCallback(
    (event: ChannelEvent) => {
      if (event.type === "message.created") {
        merge(event.message);
        return;
      }
      if (event.type === "agent.status") {
        setAgentStatuses((previous) => ({
          ...previous,
          [event.agentId]: event,
        }));
        return;
      }
      setSuppressed(true);
    },
    [merge]
  );

  useChannelSocket(channelId, onEvent);

  return {
    agentStatuses,
    channel,
    error,
    loading,
    loadOlder,
    members,
    mergeMessage: merge,
    messages,
    nextCursor,
    setMembers,
    subscribeToReplies,
    suppressed,
  };
};
