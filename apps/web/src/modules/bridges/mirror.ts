import type { Db } from "#/db/client";
import type { MessageView } from "#/modules/messaging/service";
import { listBridgesForChannel } from "./bridges";
import { recordExternalRef } from "./refs";
import { createSlackAdapter, slackClientForApp } from "./slack/adapter";
import { findSlackAppById } from "./slack/apps";
import { SLACK_CONNECTOR } from "./slack/config";

/**
 * The outbound half of the bridge layer, called from `publishMessage` right
 * after the message is stored and broadcast. Two rules hold it together:
 *
 * - a message is only mirrored to surfaces other than the one it came from,
 *   which is the echo-loop guard;
 * - mirroring never fails a message. Slack being down, rate-limited or
 *   misconfigured is invisible to the poster.
 *
 * Each bridge posts through its own app's bot token, so a message lands in
 * Slack as the agent that channel is connected to.
 */
export const mirrorMessageToBridges = async (
  db: Db,
  env: Env,
  message: MessageView
): Promise<void> => {
  try {
    const bridges = await listBridgesForChannel(db, message.channelId);

    // A channel can be bridged to several surfaces; they are independent, so
    // one slow surface does not hold up the others.
    await Promise.all(
      bridges
        .filter(
          (bridge) =>
            bridge.connector === SLACK_CONNECTOR && bridge.status === "active"
        )
        .map(async (bridge) => {
          const app = await findSlackAppById(db, bridge.slackAppId);
          const client = app ? await slackClientForApp(env, app) : null;
          // A bridge whose app was never connected (or has lost its key) is
          // simply not mirrored to; the message is unaffected.
          if (!(app && client)) {
            return;
          }
          const adapter = createSlackAdapter(db, env, app, client);
          const ref = await adapter.mirrorOutbound(message, bridge);
          if (ref) {
            await recordExternalRef(db, adapter.connector, ref);
          }
        })
    );
  } catch {
    // The message is already stored, broadcast and routed. Mirroring is the
    // one part of publishing that is allowed to fail quietly.
  }
};
