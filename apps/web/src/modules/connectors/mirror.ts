import type { Db } from "#/db/client";
import type { MessageView } from "#/modules/messaging/service";
import { listBridgesForChannel } from "./bridges";
import { recordExternalRef } from "./refs";
import { createSlackAdapter } from "./slack/adapter";
import { SLACK_CONNECTOR } from "./slack/config";

/**
 * The outbound half of the connector layer, called from `publishMessage` right
 * after the message is stored and broadcast. Two rules hold it together:
 *
 * - a message is only mirrored to surfaces other than the one it came from,
 *   which is the echo-loop guard;
 * - mirroring never fails a message. Slack being down, rate-limited or
 *   misconfigured is invisible to the poster.
 */
export const mirrorMessageToConnectors = async (
  db: Db,
  env: Env,
  message: MessageView
): Promise<void> => {
  try {
    const bridges = await listBridgesForChannel(db, message.channelId);
    const adapter = createSlackAdapter(db, env);

    // A channel can be bridged to several surfaces; they are independent, so
    // one slow surface does not hold up the others.
    await Promise.all(
      bridges
        .filter(
          (bridge) =>
            bridge.connector === SLACK_CONNECTOR && bridge.status === "active"
        )
        .map(async (bridge) => {
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
