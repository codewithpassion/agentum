// The core of the Worker's Email Routing `email()` handler. It has no
// `cloudflare:workers` import, so bun can test it. `server.ts` wraps it and
// passes the real mailbox lookup and the mail service's `receive`.

import { MAIL_MAX_INBOUND_BYTES } from "@repo/mailbox/inbound";
import type { Address, InboundMessage } from "@repo/services/mail/types";
import PostalMime, {
  type Attachment,
  type Email,
  type Header,
  type Address as ParsedAddress,
} from "postal-mime";

/** The part of a Cloudflare `ForwardableEmailMessage` this handler uses. */
export interface InboundEmail {
  readonly from: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject: (reason: string) => void;
  readonly to: string;
}

export interface InboundDeps {
  /** True when an active agent mailbox owns this (lowercased) address. */
  isActive: (address: string) => Promise<boolean>;
  /** Overrides the size cap. Defaults to `MAIL_MAX_INBOUND_BYTES`. */
  maxBytes?: number;
  /** The mail service's `receive`. A thrown error propagates so the sender retries. */
  receive: (message: InboundMessage) => Promise<void>;
}

const encoder = new TextEncoder();
const WHITESPACE = /\s+/;
const QUOTED = /^"(.*)"$/;

const lowercase = (value: string): string => value.trim().toLowerCase();

/** Reads the stream into one buffer. Returns null as soon as the bytes pass the cap. */
const readCapped = async (
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array | null> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  let result = await reader.read();
  while (!result.done) {
    total += result.value.byteLength;
    if (total > maxBytes) {
      return null;
    }
    chunks.push(result.value);
    // Each read waits for the chunk before, so the reads cannot run in parallel.
    // biome-ignore lint/performance/noAwaitInLoops: reads are sequential
    result = await reader.read();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const toAddress = (mailbox: { address: string; name: string }): Address => {
  const address = lowercase(mailbox.address);
  const name = mailbox.name.trim();
  return name === "" ? { address } : { address, name };
};

/** Flattens address groups into one list. Entries without an address are dropped. */
const flattenAddresses = (list: ParsedAddress[] | undefined): Address[] =>
  (list ?? []).flatMap((entry) => {
    const mailboxes: { address?: string; name: string }[] = entry.group ?? [
      entry,
    ];
    return mailboxes.flatMap((mailbox) =>
      mailbox.address === undefined || mailbox.address.trim() === ""
        ? []
        : [toAddress({ address: mailbox.address, name: mailbox.name })]
    );
  });

const toBytes = (
  content: Attachment["content"],
  encoding: Attachment["encoding"]
): Uint8Array => {
  if (content instanceof Uint8Array) {
    return content;
  }
  if (content instanceof ArrayBuffer) {
    return new Uint8Array(content);
  }
  if (encoding === "base64") {
    return Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
  }
  return encoder.encode(content);
};

const headerValue = (headers: Header[], key: string): string | undefined =>
  headers.find((header) => header.key === key)?.value;

/** Splits a header value on `;` outside quotes. */
const splitParameters = (value: string): string[] => {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      escaped = false;
    } else if (quoted && char === "\\") {
      escaped = true;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === ";" && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
};

/** The `report-type` parameter of a Content-Type value, lowercased, or undefined. */
const reportTypeOf = (contentType: string | undefined): string | undefined => {
  if (contentType === undefined) {
    return;
  }

  for (const part of splitParameters(contentType).slice(1)) {
    const equals = part.indexOf("=");
    if (equals === -1 || lowercase(part.slice(0, equals)) !== "report-type") {
      continue;
    }
    const value = part
      .slice(equals + 1)
      .trim()
      .replace(QUOTED, "$1")
      .toLowerCase();
    return value === "" ? undefined : value;
  }
};

const buildHeaders = (parsed: Email): InboundMessage["headers"] => {
  const autoSubmitted = headerValue(parsed.headers, "auto-submitted");
  const listId = headerValue(parsed.headers, "list-id");
  const precedence = headerValue(parsed.headers, "precedence");
  const contentType = headerValue(parsed.headers, "content-type");
  const reportType = reportTypeOf(contentType);

  return {
    ...(autoSubmitted === undefined ? {} : { autoSubmitted }),
    ...(listId === undefined ? {} : { listId }),
    ...(precedence === undefined ? {} : { precedence }),
    ...(contentType === undefined ? {} : { contentType }),
    ...(reportType === undefined ? {} : { reportType }),
  };
};

const toInboundMessage = (
  parsed: Email,
  raw: Uint8Array,
  envelope: { from: string; to: string }
): InboundMessage => {
  const from = flattenAddresses(parsed.from ? [parsed.from] : [])[0] ?? {
    address: lowercase(envelope.from),
  };

  return {
    attachments: parsed.attachments.map((attachment) => ({
      filename: attachment.filename || "untitled",
      mimetype: attachment.mimeType,
      ...(attachment.contentId === undefined
        ? {}
        : { contentId: attachment.contentId }),
      content: toBytes(attachment.content, attachment.encoding),
      disposition: attachment.disposition ?? "attachment",
    })),
    cc: flattenAddresses(parsed.cc),
    envelopeFrom: envelope.from,
    envelopeTo: envelope.to,
    from,
    headers: buildHeaders(parsed),
    inReplyTo: parsed.inReplyTo ?? null,
    messageId: parsed.messageId ?? null,
    raw,
    references: (parsed.references ?? "")
      .split(WHITESPACE)
      .filter((id) => id !== ""),
    subject: parsed.subject ?? "",
    to: flattenAddresses(parsed.to),
    ...(parsed.text === undefined ? {} : { text: parsed.text }),
    ...(parsed.html === undefined ? {} : { html: parsed.html }),
  };
};

/**
 * Handles one inbound message. It rejects oversize mail and mail for an
 * address with no active mailbox, then parses the bytes and hands the message
 * to `receive`. Errors from `receive` are not caught.
 */
export const handleInboundEmail = async (
  email: InboundEmail,
  deps: InboundDeps
): Promise<void> => {
  const maxBytes = deps.maxBytes ?? MAIL_MAX_INBOUND_BYTES;
  const to = lowercase(email.to);

  if (email.rawSize > maxBytes) {
    email.setReject("Message too large");
    return;
  }

  if (!(await deps.isActive(to))) {
    email.setReject("Unknown address");
    return;
  }

  const raw = await readCapped(email.raw, maxBytes);
  if (raw === null) {
    email.setReject("Message too large");
    return;
  }

  const parsed = await PostalMime.parse(raw);
  await deps.receive(toInboundMessage(parsed, raw, { from: email.from, to }));
};
