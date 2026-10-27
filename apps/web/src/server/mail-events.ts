// The core of the Worker's `queue()` handler for Email Sending events. It has
// no `cloudflare:workers` import, so bun can test it. `server.ts` wraps it.
//
// A subscription on the sending domain delivers `message.bounced`,
// `message.failed` and `message.rejected`. Each names the mail by the id the
// send binding reported, which the port stores as the message's RFC id.

/** The part of a queue message this handler uses. */
export interface QueuedEvent {
  ack: () => void;
  readonly body: unknown;
  retry: () => void;
}

export interface MailEventDeps {
  /** The mail service's `recordUndelivered`. A thrown error retries the event. */
  record: (report: {
    messageId: string;
    reason: string;
    status: "bounced" | "failed";
  }) => Promise<void>;
}

const STATUS_OF: Record<string, "bounced" | "failed" | undefined> = {
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.failed": "failed",
  // Rejected before delivery (suppressed recipient, policy): the mail never left.
  "cf.email.sending.message.rejected": "failed",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** The first reason string the payload carries, else the event type. */
const reasonOf = (type: string, payload: Record<string, unknown>): string => {
  const bounce = isRecord(payload.bounce) ? payload.bounce : {};
  const failure = isRecord(payload.failure) ? payload.failure : {};
  const rejection = isRecord(payload.rejection) ? payload.rejection : {};
  const delivery = isRecord(payload.delivery) ? payload.delivery : {};
  return (
    text(bounce.reason) ??
    text(failure.reason) ??
    text(rejection.detail) ??
    text(rejection.reason) ??
    text(delivery.smtpResponse) ??
    type
  );
};

/**
 * Applies each event, then acks it. Events of other types and events without a
 * message id are acked and ignored. A failure retries that event only.
 */
export const handleMailEvents = async (
  messages: readonly QueuedEvent[],
  deps: MailEventDeps
): Promise<void> => {
  for (const message of messages) {
    const { body } = message;
    const type = isRecord(body) ? text(body.type) : undefined;
    const payload =
      isRecord(body) && isRecord(body.payload) ? body.payload : {};
    const status = type ? STATUS_OF[type] : undefined;
    const messageId = text(payload.messageId);
    if (!(type && status && messageId)) {
      message.ack();
      continue;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one event at a time keeps the writes ordered
      await deps.record({
        messageId,
        reason: reasonOf(type, payload),
        status,
      });
      message.ack();
    } catch (error) {
      console.error("Mail event failed", { error, type });
      message.retry();
    }
  }
};
