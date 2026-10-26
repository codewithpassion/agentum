import { describe, expect, test } from "bun:test";
import { MAIL_MAX_INBOUND_BYTES } from "@repo/mailbox/inbound";
import type { InboundMessage } from "@repo/services/mail/types";
import {
  handleInboundEmail,
  type InboundDeps,
  type InboundEmail,
} from "./mail-inbound.ts";

const encoder = new TextEncoder();

const firstMessage = (received: InboundMessage[]): InboundMessage => {
  const [message] = received;
  if (message === undefined) {
    throw new Error("no message received");
  }
  return message;
};

/** A message as a string with CRLF line endings, the way SMTP delivers it. */
const mime = (lines: string[]): string => lines.join("\r\n");

/** A stream that only produces bytes when read, so a test can tell whether it was read. */
const readTracker = (bytes: Uint8Array) => {
  const state = { read: false };
  const raw = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.read = true;
        controller.enqueue(bytes);
        controller.close();
      },
    },
    { highWaterMark: 0 }
  );
  return { raw, state };
};

const setup = (
  source: string | Uint8Array,
  overrides: { rawSize?: number; to?: string; from?: string } = {}
) => {
  const bytes = typeof source === "string" ? encoder.encode(source) : source;
  const { raw, state } = readTracker(bytes);
  const rejections: string[] = [];
  const email: InboundEmail = {
    from: overrides.from ?? "bounce@sender.example",
    raw,
    rawSize: overrides.rawSize ?? bytes.byteLength,
    setReject: (reason) => {
      rejections.push(reason);
    },
    to: overrides.to ?? "Agent@RockyShoresLabs.io",
  };
  const received: InboundMessage[] = [];
  return { email, received, rejections, state };
};

const deps = (
  received: InboundMessage[],
  options: Partial<Pick<InboundDeps, "isActive" | "maxBytes">> & {
    receive?: InboundDeps["receive"];
  } = {}
): InboundDeps => ({
  isActive: options.isActive ?? (() => Promise.resolve(true)),
  ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  receive:
    options.receive ??
    ((message) => {
      received.push(message);
      return Promise.resolve();
    }),
});

describe("handleInboundEmail", () => {
  test("parses a plain message with addresses and threading headers", async () => {
    const source = mime([
      "From: Ada Lovelace <Ada@Example.com>",
      "To: Agent <agent@rockyshoreslabs.io>, Bob <BOB@example.org>",
      "Cc: carol@example.net",
      "Subject: Quarterly numbers",
      "Message-ID: <abc123@example.com>",
      "In-Reply-To: <prev@example.com>",
      "References: <root@example.com>  <prev@example.com>",
      "Date: Mon, 26 Oct 2026 10:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello there.",
      "",
    ]);
    const { email, rejections, received } = setup(source);
    const addresses: string[] = [];

    await handleInboundEmail(
      email,
      deps(received, {
        isActive: (address) => {
          addresses.push(address);
          return Promise.resolve(true);
        },
      })
    );

    expect(rejections).toEqual([]);
    expect(addresses).toEqual(["agent@rockyshoreslabs.io"]);
    expect(received).toHaveLength(1);
    const message = firstMessage(received);
    expect(message.envelopeTo).toBe("agent@rockyshoreslabs.io");
    expect(message.envelopeFrom).toBe("bounce@sender.example");
    expect(message.from).toStrictEqual({
      address: "ada@example.com",
      name: "Ada Lovelace",
    });
    expect(message.to).toStrictEqual([
      { address: "agent@rockyshoreslabs.io", name: "Agent" },
      { address: "bob@example.org", name: "Bob" },
    ]);
    expect(message.cc).toStrictEqual([{ address: "carol@example.net" }]);
    expect(message.subject).toBe("Quarterly numbers");
    expect(message.messageId).toBe("<abc123@example.com>");
    expect(message.inReplyTo).toBe("<prev@example.com>");
    expect(message.references).toEqual([
      "<root@example.com>",
      "<prev@example.com>",
    ]);
    expect(message.text?.trim()).toBe("Hello there.");
    expect(message.html).toBeUndefined();
    expect(message.attachments).toEqual([]);
    expect(message.headers).toStrictEqual({
      contentType: "text/plain; charset=utf-8",
    });
    expect(message.raw).toEqual(encoder.encode(source));
  });

  test("keeps the HTML part and the attachment of a multipart message", async () => {
    const source = mime([
      "From: Ada <ada@example.com>",
      "To: agent@rockyshoreslabs.io",
      "Subject: Report",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Plain body",
      "--inner",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Html body</p>",
      "--inner--",
      "--outer",
      'Content-Type: application/pdf; name="report.pdf"',
      'Content-Disposition: attachment; filename="report.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "SGVsbG8=",
      "--outer--",
      "",
    ]);
    const { email, received } = setup(source);

    await handleInboundEmail(email, deps(received));

    const message = firstMessage(received);
    expect(message.text?.trim()).toBe("Plain body");
    expect(message.html?.trim()).toBe("<p>Html body</p>");
    expect(message.attachments).toHaveLength(1);
    const [attachment] = message.attachments;
    expect(attachment?.filename).toBe("report.pdf");
    expect(attachment?.mimetype).toBe("application/pdf");
    expect(attachment?.disposition).toBe("attachment");
    expect(attachment?.contentId).toBeUndefined();
    expect(attachment?.content).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(attachment?.content)).toBe("Hello");
  });

  test("reads the report-type of a delivery status report", async () => {
    const source = mime([
      "From: Mail Delivery System <mailer-daemon@example.com>",
      "To: agent@rockyshoreslabs.io",
      "Subject: Delivery Status Notification (Failure)",
      'Content-Type: multipart/report; report-type=delivery-status; boundary="b"',
      "Auto-Submitted: auto-replied",
      "",
      "--b",
      "Content-Type: text/plain; charset=us-ascii",
      "",
      "Delivery failed.",
      "--b",
      "Content-Type: message/delivery-status",
      "",
      "Final-Recipient: rfc822; nobody@example.net",
      "--b--",
      "",
    ]);
    const { email, received } = setup(source);

    await handleInboundEmail(email, deps(received));
    expect(received).toHaveLength(1);
    const message = firstMessage(received);
    expect(message.headers.reportType).toBe("delivery-status");
    expect(message.headers.contentType).toBe(
      'multipart/report; report-type=delivery-status; boundary="b"'
    );
    expect(message.headers.autoSubmitted).toBe("auto-replied");
  });

  test("reads Auto-Submitted, List-Id and Precedence headers", async () => {
    const source = mime([
      "From: list@example.com",
      "To: agent@rockyshoreslabs.io",
      "Subject: Weekly digest",
      "List-Id: <weekly.example.com>",
      "Precedence: bulk",
      "Auto-Submitted: auto-generated",
      "Content-Type: text/plain",
      "",
      "Digest body",
      "",
    ]);
    const { email, received } = setup(source);

    await handleInboundEmail(email, deps(received));

    const message = firstMessage(received);
    expect(message.headers).toStrictEqual({
      autoSubmitted: "auto-generated",
      contentType: "text/plain",
      listId: "<weekly.example.com>",
      precedence: "bulk",
    });
    expect(message.from).toStrictEqual({ address: "list@example.com" });
  });

  test("rejects an oversize rawSize without reading the stream", async () => {
    const source = mime([
      "From: a@example.com",
      "To: agent@rockyshoreslabs.io",
      "",
      "x",
    ]);
    const { email, rejections, received, state } = setup(source, {
      rawSize: MAIL_MAX_INBOUND_BYTES + 1,
    });

    await handleInboundEmail(email, deps(received));

    expect(rejections).toEqual(["Message too large"]);
    expect(state.read).toBe(false);
    expect(received).toEqual([]);
  });

  test("rejects bytes that pass the cap even when rawSize says they do not", async () => {
    const source = mime([
      "From: a@example.com",
      "To: agent@rockyshoreslabs.io",
      "Subject: Big",
      "",
      "x".repeat(500),
    ]);
    const { email, rejections, received } = setup(source, { rawSize: 10 });

    await handleInboundEmail(email, deps(received, { maxBytes: 200 }));

    expect(rejections).toEqual(["Message too large"]);
    expect(received).toEqual([]);
  });

  test("rejects mail for an address with no active mailbox", async () => {
    const source = mime([
      "From: a@example.com",
      "To: nobody@rockyshoreslabs.io",
      "",
      "x",
    ]);
    const { email, rejections, received, state } = setup(source);

    await handleInboundEmail(
      email,
      deps(received, { isActive: async () => false })
    );

    expect(rejections).toEqual(["Unknown address"]);
    expect(state.read).toBe(false);
    expect(received).toEqual([]);
  });

  test("lets an error from receive reach the caller without rejecting the mail", async () => {
    const source = mime([
      "From: a@example.com",
      "To: agent@rockyshoreslabs.io",
      "",
      "x",
    ]);
    const { email, rejections } = setup(source);

    await expect(
      handleInboundEmail(
        email,
        deps([], {
          receive: () => Promise.reject(new Error("store unavailable")),
        })
      )
    ).rejects.toThrow("store unavailable");
    expect(rejections).toEqual([]);
  });
});
