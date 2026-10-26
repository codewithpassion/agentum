/**
 * The mail port contract. A mailbox is one agent's address, kept in a
 * per-mailbox store. These types are what the service and the port share.
 * They carry no runtime logic, except `MailError`.
 */

/** Names a mailbox. Every port call takes it first, because file keys carry the workspace. */
export interface MailboxRef {
  mailboxId: string;
  workspaceId: string;
}

/** An email address with an optional display name. */
export interface Address {
  address: string;
  name?: string;
}

/** A parsed inbound mail, as the inbound handler hands it to the port. */
export interface InboundMessage {
  attachments: {
    filename: string;
    mimetype: string;
    contentId?: string;
    disposition: string;
    content: Uint8Array;
  }[];
  cc: Address[];
  envelopeFrom: string;
  envelopeTo: string;
  from: Address;
  headers: {
    autoSubmitted?: string;
    listId?: string;
    precedence?: string;
    contentType?: string;
    reportType?: string;
  };
  html?: string;
  inReplyTo: string | null;
  messageId: string | null;
  raw: Uint8Array;
  references: string[];
  subject: string;
  text?: string;
  to: Address[];
}

/** Attachment details that are safe to show without reading the bytes. */
export interface AttachmentMeta {
  contentId?: string;
  disposition: string;
  filename: string;
  id: string;
  mimetype: string;
  size: number;
}

/** An attachment as a byte stream, for download. */
export interface StoredAttachmentBody {
  body: ReadableStream<Uint8Array>;
  filename: string;
  mimetype: string;
  size: number;
}

/** The result of storing an inbound mail. A duplicate returns the existing ids. */
export interface StoredInbound {
  attachments: AttachmentMeta[];
  duplicate: boolean;
  messageId: string;
  threadId: string;
}

/** The result of a sent mail. `rfcMessageId` is the RFC `Message-ID` header we wrote. */
export interface SentMail {
  messageId: string;
  rfcMessageId: string;
  threadId: string;
}

/** The result of a held mail, waiting for approval. */
export interface HeldMail {
  messageId: string;
  threadId: string;
}

/**
 * An outgoing mail before it is sent. The service sets `from` from the mailbox
 * row, checks it, and decides inside or outside before it calls the port.
 *
 * A recipient is inside when it is a mailbox of the same workspace, or an
 * email that `MemberDirectory` (`desk-api.ts`) resolves to a user of that
 * workspace. Everyone else is outside and needs approval, unless an "Always
 * allow" rule covers that agent and address (tool key `mail:<address>`). A
 * list of company domains does not count as inside.
 */
export interface OutgoingDraft {
  cc: string[];
  from: string;
  html?: string;
  subject: string;
  text: string;
  to: string[];
}

/** One row of the thread list. */
export interface ThreadSummary {
  /** ISO 8601 timestamp of the newest message. */
  lastMessageAt: string;
  messageCount: number;
  participants: string[];
  subject: string;
  threadId: string;
  unreadCount: number;
}

/** One message inside a thread view. */
export interface ThreadMessage {
  attachments: AttachmentMeta[];
  cc: Address[];
  /** ISO 8601 timestamp. */
  date: string;
  folder: string;
  from: Address;
  html: string | null;
  messageId: string;
  subject: string;
  text: string | null;
  to: Address[];
}

/** A whole thread, with its messages in date order. */
export interface ThreadView {
  messages: ThreadMessage[];
  threadId: string;
}

/**
 * The port to a mailbox store. The service calls it for every read and write of
 * mail. The adapter decides where the bytes and rows live.
 */
export interface MailboxPort {
  /** Drops a held mail after denial or expiry. The body is kept in the trash folder. */
  discard: (mailbox: MailboxRef, messageId: string) => Promise<void>;
  /** Stores a mail that needs approval as a draft, without sending it. */
  hold: (
    mailbox: MailboxRef,
    draft: OutgoingDraft,
    threadId?: string
  ) => Promise<HeldMail>;
  /** Lists the threads of a mailbox, one page at a time. */
  listThreads: (
    mailbox: MailboxRef,
    page: { limit: number; page: number }
  ) => Promise<ThreadSummary[]>;
  /** Reads one attachment as a stream, or null when it does not exist. */
  readAttachment: (
    mailbox: MailboxRef,
    messageId: string,
    attachmentId: string
  ) => Promise<StoredAttachmentBody | null>;
  /** Reads one thread with its messages, or null when it does not exist. */
  readThread: (
    mailbox: MailboxRef,
    threadId: string
  ) => Promise<ThreadView | null>;
  /** Sends a held mail after approval. */
  release: (mailbox: MailboxRef, messageId: string) => Promise<SentMail>;
  /** Sends a reply in an existing thread at once. */
  reply: (
    mailbox: MailboxRef,
    threadId: string,
    draft: OutgoingDraft
  ) => Promise<SentMail>;
  /** Sends a new mail at once. */
  send: (mailbox: MailboxRef, draft: OutgoingDraft) => Promise<SentMail>;
  /** Stores an inbound mail and its attachments. Idempotent on the RFC message id. */
  storeInbound: (
    mailbox: MailboxRef,
    message: InboundMessage
  ) => Promise<StoredInbound>;
}

/** Why a mail call failed. */
export type MailErrorCode = "rate_limited" | "send_failed" | "bad_request";

/** A typed mail failure. The code tells the caller whether to retry. */
export class MailError extends Error {
  readonly code: MailErrorCode;

  constructor(code: MailErrorCode, message: string) {
    super(message);
    this.name = "MailError";
    this.code = code;
  }
}

/**
 * The port to the email routing rules of the zone. One literal rule routes each
 * agent address to the Worker.
 */
export interface EmailRoutingPort {
  /** Creates the routing rule for an address. */
  createRule: (address: string) => Promise<{ id: string }>;
  /** Deletes a routing rule by its id. */
  deleteRule: (ruleId: string) => Promise<void>;
  /** Finds the routing rule for an address, or null when there is none. */
  findRule: (address: string) => Promise<{ id: string } | null>;
}
