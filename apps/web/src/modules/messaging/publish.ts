import type { Db } from "#/db/client";
import { mirrorMessageToBridges } from "#/modules/bridges/mirror";
import { notifyRouter } from "#/modules/router/notify";
import { broadcastChannelEvent } from "./realtime";
import {
  type CreateMessageInput,
  type CreateMessageResult,
  createMessage,
  type MessageView,
} from "./service";

/**
 * Everything that happens to a message once it is stored: fan out to the
 * channel's Durable Object so every open client sees it, tell the router, which
 * decides which agents wake, and mirror it to any bridged surface.
 *
 * Split out of `publishMessage` for the one caller that has work to do between
 * the write and the fan-out: asking a question writes the `agent_questions` row
 * against the message id, and the view broadcast has to already carry it.
 */
export const fanOutMessage = async (
  db: Db,
  env: Env,
  message: MessageView
): Promise<void> => {
  await broadcastChannelEvent(env, {
    channelId: message.channelId,
    message,
    type: "message.created",
  });

  await notifyRouter(db, env, message);

  // Mirrored last and never fatally: a bridged surface sees the message after
  // the workspace does, and a connector failure cannot undo a published post.
  await mirrorMessageToBridges(db, env, message);
};

/**
 * The one way a message enters the workspace: persist, fan out to the channel's
 * Durable Object so every open client sees it, then tell the router, which
 * decides which agents wake. The HTTP API, the agents' MCP tools and the
 * connectors all go through here, so all three get routing for free.
 */
export const publishMessage = async (
  db: Db,
  env: Env,
  input: CreateMessageInput
): Promise<CreateMessageResult> => {
  const result = await createMessage(db, input);
  if (!result.ok) {
    return result;
  }
  await fanOutMessage(db, env, result.message);
  return result;
};
