import type { Db } from "#/db/client";
import type { MessageView } from "#/modules/messaging/service";
import type { QuestionView } from "#/modules/questions/view";
import { listBridgesForChannel } from "./bridges";
import { findExternalId, recordExternalRef } from "./refs";
import type { ChannelBridge, SlackApp } from "./schema";
import { createSlackAdapter, slackClientForApp } from "./slack/adapter";
import { findSlackAppById } from "./slack/apps";
import type { SlackClient } from "./slack/client";
import { SLACK_CONNECTOR } from "./slack/config";
import { mirrorQuestionResolution } from "./slack/mirror";

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
const eachSlackBridge = async (
  db: Db,
  env: Env,
  channelId: string,
  act: (
    bridge: ChannelBridge,
    app: SlackApp,
    client: SlackClient
  ) => Promise<unknown>
): Promise<void> => {
  const bridges = await listBridgesForChannel(db, channelId);

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
        await act(bridge, app, client);
      })
  );
};

export const mirrorMessageToBridges = async (
  db: Db,
  env: Env,
  message: MessageView
): Promise<void> => {
  try {
    await eachSlackBridge(
      db,
      env,
      message.channelId,
      async (bridge, app, client) => {
        const adapter = createSlackAdapter(db, env, app, client);
        const ref = await adapter.mirrorOutbound(message, bridge);
        if (ref) {
          await recordExternalRef(db, adapter.connector, ref);
        }
      }
    );
  } catch {
    // The message is already stored, broadcast and routed. Mirroring is the
    // one part of publishing that is allowed to fail quietly.
  }
};

/**
 * The resolution half: a question answered on the web, or run out of time,
 * rewrites the Slack card it was mirrored to so its buttons go away.
 *
 * A Slack-sourced answer is skipped: that click already replaced its own card
 * through `response_url`, and a `chat.update` chasing it would rewrite the same
 * message with the same blocks for nothing.
 */
export const mirrorQuestionToBridges = async (
  db: Db,
  env: Env,
  update: { messageId: string; question: QuestionView }
): Promise<void> => {
  if (update.question.answeredVia === SLACK_CONNECTOR) {
    return;
  }
  try {
    const messageKey = await findExternalId(
      db,
      SLACK_CONNECTOR,
      "message",
      update.messageId
    );
    // Never mirrored - the question was asked in a channel Slack cannot see.
    if (!messageKey) {
      return;
    }
    await eachSlackBridge(
      db,
      env,
      update.question.channelId,
      // Best effort, like every other outbound Slack call: `chatUpdate` reports
      // a refusal rather than throwing, and a stale card is not worth a retry.
      (bridge, _app, client) =>
        mirrorQuestionResolution(update.question, bridge, client, messageKey)
    );
  } catch {
    // The question is already resolved, broadcast and the agent woken.
  }
};
