import type { Db } from "#/db/client";
import { askFast } from "#/modules/anthropic/fast";
import { listBridgesForChannel } from "./bridges";
import { deleteExternalRef, findExternalId, recordExternalRef } from "./refs";
import type { ChannelBridge } from "./schema";
import { slackClientForApp } from "./slack/adapter";
import { findSlackAppById } from "./slack/apps";
import type { SlackClient } from "./slack/client";
import { SLACK_CONNECTOR } from "./slack/config";
import { slackMessageKey, slackMessageTs } from "./slack/events";

/**
 * "Bruce is thinking…", in Slack.
 *
 * A thread is where somebody is most obviously waiting: they asked a follow-up
 * and are watching for the answer. Slack gives a bot no typing indicator in a
 * channel, so this is two attempts at the same idea, best first:
 *
 * 1. `assistant.threads.setStatus`, Slack's own status line under a thread. It
 *    needs the app to have the Agents & AI Apps feature; where that is on, it
 *    is exactly right - ephemeral, and cleared by Slack when the reply lands.
 * 2. A placeholder message, which every app can post, rewritten into the reply
 *    when it arrives. Not free - it is a real message - which is why it is the
 *    fallback rather than the plan.
 *
 * The line itself is written by the cheap model, so it says what is actually
 * being thought about rather than "Working…". If that call fails there is still
 * a placeholder; the wording is the part that degrades, not the indicator.
 */

/** `external_refs.internal_type` for a placeholder waiting to be replaced. */
export const THINKING_REF_TYPE = "thinking";

const FALLBACK_LINE = "Thinking…";
/** Long enough to be a phrase, short enough to read as a status. */
const MAX_LINE = 80;

const THINKING_SYSTEM = [
  "You write the one-line status an assistant shows while it works out a reply.",
  "",
  "Answer with that line and nothing else.",
  "Six words at most. Start with a verb ending in -ing.",
  "Say what is being worked on, drawn from the message - not how it will be answered.",
  'Do not answer the message. Do not use quotes. Examples: "Checking the deploy history", "Reading through the thread".',
].join("\n");

/**
 * One pending indicator per agent per thread: a second wake in the same thread
 * finds the first still there rather than posting beside it.
 */
const thinkingKey = (agentId: string, threadParentId: string): string =>
  `${agentId}:${threadParentId}`;

const slackBridgeFor = async (
  db: Db,
  channelId: string
): Promise<ChannelBridge | null> => {
  const bridges = await listBridgesForChannel(db, channelId);
  return (
    bridges.find(
      (bridge) =>
        bridge.connector === SLACK_CONNECTOR && bridge.status === "active"
    ) ?? null
  );
};

interface SlackThread {
  bridge: ChannelBridge;
  client: SlackClient;
  threadTs: string;
}

/**
 * The Slack thread an internal thread parent maps to, or null when there is no
 * such thing - an unbridged channel, an app without a usable token, or a parent
 * that was never mirrored.
 */
const resolveThread = async (
  db: Db,
  env: Env,
  channelId: string,
  threadParentId: string
): Promise<SlackThread | null> => {
  const bridge = await slackBridgeFor(db, channelId);
  if (!bridge) {
    return null;
  }
  const parentKey = await findExternalId(
    db,
    SLACK_CONNECTOR,
    "message",
    threadParentId
  );
  if (!parentKey) {
    return null;
  }
  const app = await findSlackAppById(db, bridge.slackAppId);
  const client = app ? await slackClientForApp(env, app) : null;
  return client
    ? { bridge, client, threadTs: slackMessageTs(parentKey) }
    : null;
};

/**
 * The model's answer, or `Thinking…` when it did not give one we can show.
 * A status line is decoration: anything surprising - a refusal, an explanation,
 * a paragraph - is worth less than the plain fallback, so it is discarded
 * rather than trimmed into shape.
 */
export const cleanThinkingLine = (line: string | null): string => {
  if (!line) {
    return FALLBACK_LINE;
  }
  const cleaned = line
    .split("\n")[0]
    ?.replace(/^["'`]+|["'`]+$/g, "")
    .trim();
  return cleaned && cleaned.length <= MAX_LINE ? cleaned : FALLBACK_LINE;
};

const thinkingLine = async (env: Env, body: string): Promise<string> =>
  cleanThinkingLine(
    await askFast(env, {
      maxTokens: 32,
      prompt: `Message: ${body}`,
      system: THINKING_SYSTEM,
    })
  );

export interface ThinkingInput {
  agentId: string;
  /** The message being answered, which is what the line is written from. */
  body: string;
  channelId: string;
  threadParentId: string;
}

/**
 * Shows that the agent has started. Never throws and never blocks the wake:
 * an indicator that fails to appear costs nothing, and a wake that failed
 * because of one would cost the reply.
 */
export const showThinking = async (
  db: Db,
  env: Env,
  input: ThinkingInput
): Promise<void> => {
  try {
    const thread = await resolveThread(
      db,
      env,
      input.channelId,
      input.threadParentId
    );
    if (!thread) {
      return;
    }

    const key = thinkingKey(input.agentId, input.threadParentId);
    // Already showing something for this agent in this thread.
    if (await findExternalId(db, SLACK_CONNECTOR, THINKING_REF_TYPE, key)) {
      return;
    }

    const line = await thinkingLine(env, input.body);
    const shown = await thread.client.assistantSetStatus({
      channel: thread.bridge.externalChannelId,
      status: line,
      threadTs: thread.threadTs,
    });
    if (shown) {
      // Slack owns this one: it clears the status when the app next posts in
      // the thread, so there is nothing of ours to take back.
      return;
    }

    const posted = await thread.client.postMessage({
      channel: thread.bridge.externalChannelId,
      text: `_${line}_`,
      threadTs: thread.threadTs,
    });
    if (!posted) {
      return;
    }
    await recordExternalRef(db, SLACK_CONNECTOR, {
      externalId: slackMessageKey(thread.bridge.externalChannelId, posted.ts),
      internalId: key,
      internalType: THINKING_REF_TYPE,
    });
  } catch {
    // Best effort throughout: this is decoration on somebody else's reply.
  }
};

/**
 * The placeholder waiting in this thread, claimed so the caller may rewrite it.
 * Removing the row here is what makes the claim exclusive - whoever takes it
 * owns replacing or deleting that message.
 */
export const takeThinkingPlaceholder = async (
  db: Db,
  agentId: string,
  threadParentId: string
): Promise<string | null> => {
  const key = thinkingKey(agentId, threadParentId);
  const messageKey = await findExternalId(
    db,
    SLACK_CONNECTOR,
    THINKING_REF_TYPE,
    key
  );
  if (!messageKey) {
    return null;
  }
  await deleteExternalRef(db, SLACK_CONNECTOR, THINKING_REF_TYPE, key);
  return messageKey;
};

/**
 * Takes the indicator back when no reply is coming - the agent errored, was
 * suppressed, or simply had nothing to say. Without this a thread keeps a
 * "Thinking…" that never resolves, which reads far worse than no indicator.
 */
export const clearThinking = async (
  db: Db,
  env: Env,
  input: { agentId: string; channelId: string; threadParentId: string }
): Promise<void> => {
  try {
    const placeholder = await takeThinkingPlaceholder(
      db,
      input.agentId,
      input.threadParentId
    );
    const thread = await resolveThread(
      db,
      env,
      input.channelId,
      input.threadParentId
    );
    if (!thread) {
      return;
    }
    if (placeholder) {
      await thread.client.chatDelete({
        channel: thread.bridge.externalChannelId,
        ts: slackMessageTs(placeholder),
      });
      return;
    }
    // The `setStatus` path left nothing behind, so clearing it is saying so.
    await thread.client.assistantSetStatus({
      channel: thread.bridge.externalChannelId,
      status: "",
      threadTs: thread.threadTs,
    });
  } catch {
    // Same bargain as showing it.
  }
};
