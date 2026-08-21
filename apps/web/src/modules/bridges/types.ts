import type {
  CreateMessageInput,
  MessageView,
} from "#/modules/messaging/service";
import type { ChannelBridge } from "./schema";

/**
 * The contract every bridge adapter implements. It is deliberately two functions:
 * one turns an external event into a message we can publish, the other turns a
 * published message into an external post. Everything else about a surface -
 * transport, auth, payload shapes - stays inside its own adapter.
 */

/** What a bridge adapter hands to `publishMessage`, plus the id to remember it by. */
export interface InboundMessage {
  /** Stable external identity of the source message, e.g. `C123:1700.0002`. */
  externalId: string;
  input: CreateMessageInput;
}

/** Where a mirrored message ended up on the external surface. */
export interface ExternalRefInput {
  externalId: string;
  internalId: string;
  /**
   * `thinking` is the odd one out: not a mirrored thing, but a placeholder
   * message waiting to be rewritten into the agent's reply. It rides here
   * because the mapping it needs - ours to Slack's `channel:ts` - is exactly
   * what this table is.
   */
  internalType: "author" | "channel" | "message" | "thinking";
}

export interface BridgeAdapter<TEvent> {
  /** Stable key stored in `origin`, `external_refs.connector` and bridge rows. */
  readonly connector: string;
  /** Human-readable, for the UI. */
  readonly label: string;
  /** `null` when nothing was mirrored (not configured, or the post failed). */
  mirrorOutbound: (
    message: MessageView,
    bridge: ChannelBridge
  ) => Promise<ExternalRefInput | null>;
  /**
   * `null` when the event is not something we publish: a bot echo, an
   * unbridged channel, a duplicate delivery, or an unsupported event type.
   * Async because resolving the channel, the thread parent and attachments all
   * need I/O - the pure parts are separate, testable functions.
   */
  normalizeInbound: (event: TEvent) => Promise<InboundMessage | null>;
}
