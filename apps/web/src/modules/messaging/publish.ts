import type { Db } from "#/db/client";
import { mirrorMessageToBridges } from "#/modules/bridges/mirror";
import { notifyRouter } from "#/modules/router/notify";
import { broadcastChannelEvent } from "./realtime";
import {
  type CreateMessageInput,
  type CreateMessageResult,
  createMessage,
} from "./service";

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

  await broadcastChannelEvent(env, {
    channelId: result.message.channelId,
    message: result.message,
    type: "message.created",
  });

  await notifyRouter(db, env, result.message);

  // Mirrored last and never fatally: a bridged surface sees the message after
  // the workspace does, and a connector failure cannot undo a published post.
  await mirrorMessageToBridges(db, env, result.message);

  return result;
};
