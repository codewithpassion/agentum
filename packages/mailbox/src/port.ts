// The MailboxPort over a mailbox Durable Object, the FILES bucket and the
// send_email binding. Written for Harbourmaster (MIT). It follows the send and
// receive flows of agentic-inbox-hei (workers/lib/tools.ts and
// workers/index.ts, Apache-2.0, see NOTICE), without verifyDraft, deferred
// delivery or quoted replies.

import {
  type AttachmentMeta,
  type HeldMail,
  type InboundMessage,
  type MailboxPort,
  type MailboxRef,
  MailError,
  type OutgoingDraft,
  type SentMail,
  type StoredInbound,
  type ThreadMessage,
} from "@repo/services/mail/types";
import {
  attachmentKey,
  capBody,
  dedupeKeyFor,
  rawMimeKey,
  safeFilename,
} from "./inbound.ts";
import {
  bodyOf,
  buildSendMessage,
  type EmailSender,
  fromDomain,
  stripHtmlToText,
} from "./send.ts";
import type {
  AttachmentRow,
  EmailRow,
  InboundInsert,
  MailboxStore,
  StoredEmail,
} from "./store.ts";
import { FOLDERS } from "./store.ts";
import {
  buildReferencesChain,
  extractMessageId,
  generateMessageId,
} from "./threading.ts";

type Async<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/**
 * What the port needs from one mailbox's Durable Object: the store, awaitable.
 * A `DurableObjectStub<MailboxDO>` satisfies it.
 */
export type MailboxClient = Async<MailboxStore>;

/** The part of `FileBlobs` (`@repo/services/files`) the port uses. */
export interface MailBlobs {
  get: (key: string) => Promise<ReadableStream<Uint8Array> | null>;
  put: (key: string, body: Blob, contentType: string) => Promise<void>;
}

export interface MailboxPortOptions {
  files: MailBlobs;
  /** The Durable Object client for a mailbox row id. */
  mailbox: (mailboxId: string) => MailboxClient;
  newId?: () => string;
  now?: () => Date;
  sender: EmailSender;
}

const toMeta = (row: AttachmentRow): AttachmentMeta => ({
  ...(row.contentId ? { contentId: row.contentId } : {}),
  disposition: row.disposition ?? "attachment",
  filename: row.filename,
  id: row.id,
  mimetype: row.mimetype,
  size: row.size,
});

const splitAddresses = (value: string | null): string[] =>
  (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

const formatAddress = ({
  address,
  name,
}: {
  address: string;
  name?: string;
}): string => (name ? `${name} <${address}>` : address);

const headerJson = (entries: [string, string | undefined][]): string =>
  JSON.stringify(
    entries
      .filter((entry): entry is [string, string] => Boolean(entry[1]))
      .map(([key, value]) => ({ key, value }))
  );

const bracketed = (ids: string[]): string | undefined =>
  ids.length > 0 ? ids.map((id) => `<${id}>`).join(" ") : undefined;

/** The mail a reply answers: the newest inbound mail, else the newest mail that is not a draft. */
const replyTarget = (thread: StoredEmail[]): StoredEmail | null =>
  [...thread].reverse().find((row) => row.folderId === FOLDERS.inbox) ??
  [...thread].reverse().find((row) => row.folderId !== FOLDERS.draft) ??
  null;

const textOf = (row: EmailRow): string | null => {
  if (!row.body) {
    return null;
  }
  return row.bodyIsHtml ? stripHtmlToText(row.body) : row.body;
};

const toThreadMessage = (row: StoredEmail): ThreadMessage => ({
  attachments: row.attachments.map(toMeta),
  cc: splitAddresses(row.cc).map((address) => ({ address })),
  date: row.date ?? "",
  folder: row.folderId,
  from: { address: row.sender ?? "" },
  html: row.body && row.bodyIsHtml ? row.body : null,
  messageId: row.id,
  subject: row.subject ?? "",
  text: textOf(row),
  to: splitAddresses(row.recipient).map((address) => ({ address })),
});

/** The store's insert for a parsed inbound mail. */
const inboundRow = (
  message: InboundMessage,
  parts: {
    attachments: InboundInsert["attachments"];
    dedupeKey: string;
    id: string;
    now: Date;
  }
): InboundInsert => {
  const references = message.references
    .map(extractMessageId)
    .filter((value) => value !== "");
  const inReplyTo = message.inReplyTo
    ? extractMessageId(message.inReplyTo) || null
    : null;
  const rfcId = message.messageId ? extractMessageId(message.messageId) : "";
  const text = message.text ?? "";
  const html = message.html ?? "";
  return {
    attachments: parts.attachments,
    body: capBody(text || html),
    bodyIsHtml: !text && html !== "",
    cc:
      message.cc.length > 0
        ? message.cc.map((a) => a.address.toLowerCase()).join(", ")
        : null,
    date: parts.now.toISOString(),
    dedupeKey: parts.dedupeKey,
    id: parts.id,
    inReplyTo,
    // The dedupe key may be a hash, so only a real header reaches message_id.
    messageId: rfcId || null,
    rawHeaders: headerJson([
      ["message-id", rfcId ? `<${rfcId}>` : undefined],
      ["in-reply-to", inReplyTo ? `<${inReplyTo}>` : undefined],
      ["references", bracketed(references)],
      ["from", formatAddress(message.from)],
      ["to", message.to.map(formatAddress).join(", ")],
      ["cc", message.cc.map(formatAddress).join(", ")],
      ["auto-submitted", message.headers.autoSubmitted],
      ["list-id", message.headers.listId],
      ["precedence", message.headers.precedence],
    ]),
    recipient: message.to.map((a) => a.address.toLowerCase()).join(", "),
    references,
    sender: message.from.address.toLowerCase(),
    subject: message.subject,
  };
};

/** The mail a held reply answers, found in its thread by the RFC id it recorded. */
const heldOriginal = (thread: StoredEmail[], held: StoredEmail) =>
  thread.find(
    (mail) =>
      mail.id !== held.id &&
      (mail.messageId === held.inReplyTo || mail.id === held.inReplyTo)
  ) ?? null;

/** Turns a held row back into the draft it was made from. */
const draftOf = (row: StoredEmail): OutgoingDraft => ({
  cc: splitAddresses(row.cc),
  from: row.sender ?? "",
  html: row.bodyIsHtml ? (row.body ?? undefined) : undefined,
  subject: row.subject ?? "",
  text: textOf(row) ?? "",
  to: splitAddresses(row.recipient),
});

export const createMailboxPort = ({
  files,
  mailbox,
  newId = () => crypto.randomUUID(),
  now = () => new Date(),
  sender,
}: MailboxPortOptions): MailboxPort => {
  const deliver = async (
    message: ReturnType<typeof buildSendMessage>
  ): Promise<void> => {
    try {
      await sender.send(message);
    } catch (error) {
      // biome-ignore lint/style/useErrorCause: MailError takes a code and a message only
      throw new MailError(
        "send_failed",
        `Failed to send email: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const checkDraft = (draft: OutgoingDraft): string => {
    const domain = fromDomain(draft.from);
    if (!domain) {
      throw new MailError("bad_request", "Invalid sender email address");
    }
    if (draft.to.length === 0) {
      throw new MailError("bad_request", "A mail needs at least one recipient");
    }
    return domain;
  };

  const checkRateLimit = async (client: MailboxClient): Promise<void> => {
    const limited = await client.checkSendRateLimit();
    if (limited) {
      throw new MailError("rate_limited", limited);
    }
  };

  /** The fields of an outgoing row. The caller adds the id, thread and folder. */
  const outgoingRow = (
    draft: OutgoingDraft,
    ids: {
      emailReferences: string[];
      id: string;
      inReplyTo: string | null;
      rfcMessageId: string;
      threadId: string;
    }
  ) => {
    const { body, isHtml } = bodyOf(draft);
    const date = now().toISOString();
    return {
      bcc: null,
      body: capBody(body),
      bodyIsHtml: isHtml,
      cc: draft.cc.length > 0 ? draft.cc.join(", ").toLowerCase() : null,
      date,
      dedupeKey: null,
      emailReferences:
        ids.emailReferences.length > 0
          ? JSON.stringify(ids.emailReferences)
          : null,
      id: ids.id,
      inReplyTo: ids.inReplyTo,
      messageId: ids.rfcMessageId,
      rawHeaders: headerJson([
        ["from", draft.from],
        ["to", draft.to.join(", ")],
        ["cc", draft.cc.join(", ")],
        ["subject", draft.subject],
        ["date", date],
        ["message-id", `<${ids.rfcMessageId}>`],
        ["in-reply-to", ids.inReplyTo ? `<${ids.inReplyTo}>` : undefined],
        ["references", bracketed(ids.emailReferences)],
      ]),
      recipient: draft.to.join(", ").toLowerCase(),
      sender: draft.from.toLowerCase(),
      subject: draft.subject,
      threadId: ids.threadId,
    } satisfies Omit<EmailRow, "attachments" | "folderId" | "read" | "starred">;
  };

  const readThreadRows = async (
    client: MailboxClient,
    threadId: string
  ): Promise<StoredEmail[]> => {
    const thread = await client.getThreadEmails(threadId);
    if (thread.length === 0) {
      throw new MailError("bad_request", "Thread not found");
    }
    return thread;
  };

  const sendNew = async (
    mailboxRef: MailboxRef,
    draft: OutgoingDraft,
    original: StoredEmail | null
  ): Promise<SentMail> => {
    const client = mailbox(mailboxRef.mailboxId);
    const domain = checkDraft(draft);
    await checkRateLimit(client);
    const { id, rfcMessageId } = generateMessageId(domain, newId);
    const chain = original ? buildReferencesChain(original) : undefined;
    await deliver(buildSendMessage(draft, rfcMessageId, chain));
    const threadId = chain ? chain.threadId : rfcMessageId;
    await client.createEmail(
      FOLDERS.sent,
      outgoingRow(draft, {
        emailReferences: chain ? chain.references : [],
        id,
        inReplyTo: chain ? chain.inReplyTo : null,
        rfcMessageId,
        threadId,
      }),
      []
    );
    return { messageId: id, rfcMessageId, threadId };
  };

  return {
    discard: async (ref, messageId) => {
      const client = mailbox(ref.mailboxId);
      const row = await client.getEmail(messageId);
      if (row?.folderId !== FOLDERS.draft) {
        throw new MailError("bad_request", "No held mail with that id");
      }
      await client.moveEmail(messageId, FOLDERS.trash);
    },

    hold: async (ref, draft, threadId): Promise<HeldMail> => {
      const client = mailbox(ref.mailboxId);
      const domain = checkDraft(draft);
      const original = threadId
        ? replyTarget(await readThreadRows(client, threadId))
        : null;
      const { id, rfcMessageId } = generateMessageId(domain, newId);
      const chain = original ? buildReferencesChain(original) : undefined;
      const held = chain ? chain.threadId : (threadId ?? rfcMessageId);
      // The References chain is built again when the mail is released.
      await client.createEmail(
        FOLDERS.draft,
        outgoingRow(draft, {
          emailReferences: [],
          id,
          inReplyTo: chain ? chain.inReplyTo : null,
          rfcMessageId,
          threadId: held,
        }),
        []
      );
      return { messageId: id, threadId: held };
    },

    listThreads: (ref, page) => mailbox(ref.mailboxId).listThreads(page),

    readAttachment: async (ref, messageId, attachmentId) => {
      const row = await mailbox(ref.mailboxId).getAttachment(attachmentId);
      if (row?.emailId !== messageId) {
        return null;
      }
      const body = await files.get(
        attachmentKey(ref, messageId, attachmentId, row.filename)
      );
      return body
        ? {
            body,
            filename: row.filename,
            mimetype: row.mimetype,
            size: row.size,
          }
        : null;
    },

    readThread: async (ref, threadId) => {
      const rows = await mailbox(ref.mailboxId).getThreadEmails(threadId);
      return rows.length === 0
        ? null
        : { messages: rows.map(toThreadMessage), threadId };
    },

    release: async (ref, messageId): Promise<SentMail> => {
      const client = mailbox(ref.mailboxId);
      const row = await client.getEmail(messageId);
      if (row?.folderId !== FOLDERS.draft) {
        throw new MailError("bad_request", "No held mail with that id");
      }
      const domain = fromDomain(row.sender ?? "");
      if (!domain) {
        throw new MailError("bad_request", "Invalid sender email address");
      }
      await checkRateLimit(client);
      const threadId = row.threadId ?? row.id;
      const rfcMessageId = row.messageId ?? `${row.id}@${domain}`;
      const original = row.inReplyTo
        ? heldOriginal(await client.getThreadEmails(threadId), row)
        : null;
      const chain = original ? buildReferencesChain(original) : undefined;
      await deliver(buildSendMessage(draftOf(row), rfcMessageId, chain));
      // The rate limit counts sent mail by date, so the date moves to the send.
      await client.updateEmail(row.id, {
        date: now().toISOString(),
        emailReferences: chain ? JSON.stringify(chain.references) : null,
      });
      await client.moveEmail(row.id, FOLDERS.sent);
      return { messageId: row.id, rfcMessageId, threadId };
    },

    reply: async (ref, threadId, draft) => {
      const client = mailbox(ref.mailboxId);
      const original = replyTarget(await readThreadRows(client, threadId));
      return sendNew(ref, draft, original);
    },

    send: (ref, draft) => sendNew(ref, draft, null),

    storeInbound: async (ref, message): Promise<StoredInbound> => {
      const client = mailbox(ref.mailboxId);
      const dedupeKey = await dedupeKeyFor({
        messageId: message.messageId,
        raw: message.raw,
      });
      const known = await client.findByDedupeKey(dedupeKey);
      if (known) {
        return {
          attachments: known.attachments.map(toMeta),
          duplicate: true,
          messageId: known.id,
          threadId: known.threadId,
        };
      }
      return storeNewInbound(ref, message, dedupeKey);
    },
  };

  async function storeNewInbound(
    ref: MailboxRef,
    message: InboundMessage,
    dedupeKey: string
  ): Promise<StoredInbound> {
    const id = newId();
    // Bytes first and the row last, so a stored row always has its files.
    await files.put(
      rawMimeKey(ref, id),
      new Blob([message.raw.slice()]),
      "message/rfc822"
    );
    const stored = await Promise.all(
      message.attachments.map(async (attachment) => {
        const attachmentId = newId();
        const filename = safeFilename(attachment.filename);
        await files.put(
          attachmentKey(ref, id, attachmentId, filename),
          new Blob([attachment.content.slice()]),
          attachment.mimetype
        );
        return {
          contentId: attachment.contentId ?? null,
          disposition: attachment.disposition,
          filename,
          id: attachmentId,
          mimetype: attachment.mimetype,
          size: attachment.content.byteLength,
        };
      })
    );
    const result = await mailbox(ref.mailboxId).insertInbound(
      inboundRow(message, { attachments: stored, dedupeKey, id, now: now() })
    );
    return {
      attachments: result.attachments.map(toMeta),
      duplicate: result.duplicate,
      messageId: result.id,
      threadId: result.threadId,
    };
  }
};
