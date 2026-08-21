import type { QuestionView } from "#/modules/questions/view";
import type { MessageView } from "./service";

/**
 * What a channel's Durable Object fans out to open clients. The union is
 * discriminated on `type`, and clients must ignore members they do not know -
 * an older tab should not break when a new event ships.
 */

export interface MessageCreatedEvent {
  channelId: string;
  message: MessageView;
  type: "message.created";
}

/** The router's view of an agent, mirrored live into every open channel view. */
export interface AgentStatusEvent {
  agentId: string;
  agentName: string;
  channelId: string;
  status: "idle" | "queued" | "working" | "error";
  type: "agent.status";
}

/** The channel's loop guard closed: agents stay quiet until a human posts. */
export interface RouterSuppressedEvent {
  channelId: string;
  type: "router.suppressed";
}

/**
 * A question was answered or expired. The card is drawn from the question that
 * came with its message, so this event carries the whole replacement rather
 * than a status: whoever answered - a web card, a Slack button, the expiry
 * sweep - every open client redraws from the same shape.
 */
export interface QuestionUpdatedEvent {
  channelId: string;
  /** The question card message, which is what a client keys the card by. */
  messageId: string;
  question: QuestionView;
  type: "question.updated";
}

export type ChannelEvent =
  | AgentStatusEvent
  | MessageCreatedEvent
  | QuestionUpdatedEvent
  | RouterSuppressedEvent;

const roomFor = (env: Env, channelId: string) =>
  env.CHANNEL_ROOM.get(env.CHANNEL_ROOM.idFromName(channelId));

export const broadcastChannelEvent = async (
  env: Env,
  event: ChannelEvent
): Promise<void> => {
  await roomFor(env, event.channelId).broadcast(JSON.stringify(event));
};

/** Hands a WebSocket upgrade to the channel's room, 101 response untouched. */
export const connectToChannelRoom = (
  env: Env,
  channelId: string,
  request: Request
): Promise<Response> => roomFor(env, channelId).fetch(request);
