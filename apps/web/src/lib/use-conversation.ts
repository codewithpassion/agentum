import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentStatusEvent,
  ChannelEvent,
} from "#/modules/messaging/realtime";
import type { Channel, ChannelMemberView, MessageView, Question } from "./api";
import { useChannelSocket } from "./use-channel-socket";
import { useApi } from "./workspace-context";

export type ReplyListener = (message: MessageView) => void;
export type QuestionListener = (question: Question) => void;

/** The router's live view of the agents woken from this channel. */
export type AgentStatuses = Record<string, AgentStatusEvent>;

export interface Conversation {
  /** Keyed by agent id; only agents the router has reported on appear. */
  agentStatuses: AgentStatuses;
  /**
   * The one way a question card changes state, whoever decided it: the socket
   * event, the answer this tab posted, or the 409 that named the winner.
   */
  applyQuestion: QuestionListener;
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
  /**
   * Question state as it lands, for the surfaces that hold their own copy of a
   * message: the thread panel's parent, and the badges outside this channel.
   */
  subscribeToQuestions: (listener: QuestionListener) => () => void;
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
  const api = useApi();
  const [channel, setChannel] = useState<Channel | null>(null);
  const [members, setMembers] = useState<ChannelMemberView[]>([]);
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatuses>({});
  const [suppressed, setSuppressed] = useState(false);
  const seenReplyIds = useRef(new Set<string>());
  const seenQuestionIds = useRef(new Set<string>());
  const replyListeners = useRef(new Set<ReplyListener>());
  const questionListeners = useRef(new Set<QuestionListener>());

  const subscribeToReplies = useCallback((listener: ReplyListener) => {
    replyListeners.current.add(listener);
    return () => {
      replyListeners.current.delete(listener);
    };
  }, []);

  const subscribeToQuestions = useCallback((listener: QuestionListener) => {
    questionListeners.current.add(listener);
    return () => {
      questionListeners.current.delete(listener);
    };
  }, []);

  const notifyQuestion = useCallback((question: Question) => {
    for (const listener of questionListeners.current) {
      listener(question);
    }
  }, []);

  /**
   * A question replaces the one hanging off its card message. The message is
   * left alone when it is not loaded here - a question answered in a channel
   * this tab is not looking at reaches the badges through the listeners.
   */
  const applyQuestion = useCallback(
    (question: Question) => {
      setMessages((previous) =>
        previous.map((entry) =>
          entry.id === question.messageId ? { ...entry, question } : entry
        )
      );
      notifyQuestion(question);
    },
    [notifyQuestion]
  );

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
    seenQuestionIds.current = new Set();
    setLoading(true);

    /**
     * The socket only reports status transitions, so a tab opened after an
     * agent started working would show no activity until the next one. Asking
     * once for each agent member's current status closes that gap; live
     * events overwrite the snapshot, never the other way around.
     */
    const seedAgentStatuses = (channelMembers: ChannelMemberView[]) => {
      const agents = channelMembers.filter(
        (member) => member.memberType === "agent" && member.name
      );
      Promise.all(
        agents.map(async (member) => {
          const status = await api
            .getAgentStatus(member.memberId)
            .catch(() => null);
          return status
            ? ({
                agentId: member.memberId,
                agentName: member.name ?? "",
                channelId,
                status: status.status,
                type: "agent.status",
              } satisfies AgentStatusEvent)
            : null;
        })
      ).then((snapshot) => {
        if (cancelled) {
          return;
        }
        const seeded: AgentStatuses = {};
        for (const entry of snapshot) {
          if (entry) {
            seeded[entry.agentId] = entry;
          }
        }
        setAgentStatuses((previous) => ({ ...seeded, ...previous }));
      });
    };

    (async () => {
      try {
        const [details, page] = await Promise.all([
          api.getChannel(channelId),
          api.listMessages(channelId),
        ]);
        if (cancelled) {
          return;
        }
        setChannel(details.channel);
        setMembers(details.members);
        setMessages([...page.messages].reverse());
        setNextCursor(page.nextCursor);
        setError(null);
        seedAgentStatuses(details.members);
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
  }, [api, channelId]);

  const loadOlder = useCallback(async () => {
    if (!(channelId && nextCursor)) {
      return;
    }
    const page = await api.listMessages(channelId, nextCursor);
    setMessages((previous) => [...[...page.messages].reverse(), ...previous]);
    setNextCursor(page.nextCursor);
  }, [api, channelId, nextCursor]);

  const merge = useCallback(
    (message: MessageView) => {
      if (message.authorType !== "agent") {
        // A human back in the conversation is exactly what reopens a channel
        // the router suppressed, so the notice goes with them.
        setSuppressed(false);
      }
      // A card arrives twice - the POST response and the broadcast - so the
      // "an agent is now waiting" notice is sent once, on first sight.
      const asked = message.question;
      if (asked && !seenQuestionIds.current.has(asked.id)) {
        seenQuestionIds.current.add(asked.id);
        notifyQuestion(asked);
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
    },
    [notifyQuestion]
  );

  const onEvent = useCallback(
    (event: ChannelEvent) => {
      if (event.type === "message.created") {
        merge(event.message);
        return;
      }
      if (event.type === "question.updated") {
        applyQuestion(event.question);
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
    [applyQuestion, merge]
  );

  useChannelSocket(channelId, onEvent);

  return {
    agentStatuses,
    applyQuestion,
    channel,
    error,
    loading,
    loadOlder,
    members,
    mergeMessage: merge,
    messages,
    nextCursor,
    setMembers,
    subscribeToQuestions,
    subscribeToReplies,
    suppressed,
  };
};
