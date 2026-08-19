import type {
  CreateMessageInput,
  CreateMessageResult,
} from "#/modules/messaging/service";
import type { ConnectorAdapter, ExternalRefInput } from "../types";
import type { SlackEventCallback } from "./events";

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
  /** False when this event id was already claimed - Slack is retrying. */
  claimEvent: (eventId: string) => Promise<boolean>;
  publish: (input: CreateMessageInput) => Promise<CreateMessageResult>;
  recordMessageRef: (ref: ExternalRefInput) => Promise<void>;
}

export const ingestSlackEvent = async (
  payload: SlackEventCallback,
  adapter: ConnectorAdapter<SlackEventCallback>,
  ports: SlackIngestPorts
): Promise<IngestOutcome> => {
  if (!(await ports.claimEvent(payload.event_id))) {
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
