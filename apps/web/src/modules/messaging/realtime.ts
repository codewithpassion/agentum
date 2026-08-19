import type { MessageView } from "./service";

export interface ChannelEvent {
  channelId: string;
  message: MessageView;
  type: "message.created";
}

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
