import type {
  CreateMessageInput,
  CreateMessageResult,
} from "#/modules/messaging/service";
import type { BridgeAdapter, ExternalRefInput } from "../types";
import { type SlackEventCallback, slackMessageKey } from "./events";
import { isPublishableEvent } from "./normalize";

/**
 * What happens to a verified Slack event: claim its id, normalise it, publish
 * it through the one message-write seam, then remember which Slack message it
 * became so replies can thread back.
 *
 * Runs after the 200 has been sent (`ctx.waitUntil`), which is why every step
 * reports rather than throws.
 */

export type IngestOutcome = "duplicate" | "ignored" | "published" | "rejected";

export interface SlackIngestPorts {
  /**
   * False when this key was already claimed. Called twice: once for the
   * delivery id, once for the message identity - see `claimSlackKey`.
   */
  claim: (key: string) => Promise<boolean>;
  publish: (input: CreateMessageInput) => Promise<CreateMessageResult>;
  recordMessageRef: (ref: ExternalRefInput) => Promise<void>;
}

/**
 * The message identity this delivery carries, or null when the event is not
 * one we would publish anyway - an unclaimed key costs nothing, a claimed one
 * that never publishes would block the delivery that would have.
 */
const messageKeyOf = (payload: SlackEventCallback): string | null => {
  const { event } = payload;
  return isPublishableEvent(event) && event.channel && event.ts
    ? slackMessageKey(event.channel, event.ts)
    : null;
};

export const ingestSlackEvent = async (
  payload: SlackEventCallback,
  adapter: BridgeAdapter<SlackEventCallback>,
  ports: SlackIngestPorts
): Promise<IngestOutcome> => {
  if (!(await ports.claim(payload.event_id))) {
    return "duplicate";
  }

  // Claimed before the work, not after it. A channel message that mentions the
  // bot is delivered twice under two delivery ids, and both land in their own
  // Worker invocation: whichever inserts this key first is the one that
  // publishes, and the other stops here.
  const messageKey = messageKeyOf(payload);
  if (messageKey && !(await ports.claim(messageKey))) {
    return "duplicate";
  }

  const inbound = await adapter.normalizeInbound(payload);
  if (!inbound) {
    return "ignored";
  }

  const result = await ports.publish(inbound.input);
  if (!result.ok) {
    return "rejected";
  }

  await ports.recordMessageRef({
    externalId: inbound.externalId,
    internalId: result.message.id,
    internalType: "message",
  });
  return "published";
};
