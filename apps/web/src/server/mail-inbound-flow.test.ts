// A raw message through the inbound handler into the real mail service, over
// an in-memory database and a fake mailbox port.
import { beforeEach, expect, test } from "bun:test";
import { sqliteAtomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { agentMailboxes, mailThreads } from "@repo/db/schema/mail";
import { workspaces } from "@repo/db/schema/workspaces";
import { migrated } from "@repo/db/test-db";
import { noopRelay } from "@repo/services/machines/types";
import type { InboundMessage, MailboxPort } from "@repo/services/mail/types";
import { systemClock } from "@repo/services/runs/types";
import { SYSTEM_PRINCIPAL } from "@repo/services/workspaces";
import { composeWith } from "./compose.ts";
import { handleInboundEmail } from "./mail-inbound.ts";

const now = "2026-10-27T00:00:00.000Z";
let db: ReturnType<typeof migrated>;
let stored: InboundMessage[];
let services: ReturnType<typeof composeWith>["services"];

const port: MailboxPort = {
  discard: () => Promise.resolve(),
  hold: () => Promise.resolve({ messageId: "h", threadId: "t" }),
  listThreads: () => Promise.resolve([]),
  readAttachment: () => Promise.resolve(null),
  readThread: () => Promise.resolve(null),
  release: () =>
    Promise.resolve({ messageId: "m", rfcMessageId: "r", threadId: "t" }),
  reply: () =>
    Promise.resolve({ messageId: "m", rfcMessageId: "r", threadId: "t" }),
  send: () =>
    Promise.resolve({ messageId: "m", rfcMessageId: "r", threadId: "t" }),
  storeInbound: (_ref, message) => {
    stored.push(message);
    return Promise.resolve({
      attachments: [],
      duplicate: false,
      messageId: `msg-${stored.length}`,
      threadId: `thread-${stored.length}`,
    });
  },
};

const stream = (text: string): ReadableStream<Uint8Array> =>
  new Response(text).body ?? new ReadableStream();

const deliver = async (to: string, raw: string) => {
  const rejected: string[] = [];
  await handleInboundEmail(
    {
      from: "sender@example.net",
      raw: stream(raw),
      rawSize: raw.length,
      setReject: (reason) => rejected.push(reason),
      to,
    },
    {
      isActive: (address) =>
        services.mail.agent.isActiveAddress(SYSTEM_PRINCIPAL, address),
      receive: (message) => services.mail.receive(message),
    }
  );
  return rejected;
};

const plain = [
  "From: Sender <sender@example.net>",
  "To: a@example.com",
  "Subject: Hello",
  "Message-ID: <one@example.net>",
  "",
  "Please help.",
  "",
].join("\r\n");

const readReceipt = [
  "From: sender@example.net",
  "To: a@example.com",
  "Subject: Read: Hello",
  "Message-ID: <receipt@example.net>",
  'Content-Type: multipart/report; report-type=disposition-notification; boundary="b"',
  "",
  "--b",
  "Content-Type: text/plain",
  "",
  "Read.",
  "--b--",
  "",
].join("\r\n");

beforeEach(() => {
  db = migrated();
  stored = [];
  db.insert(workspaces)
    .values({
      clerkOrgId: "org",
      createdAt: now,
      id: "w",
      name: "W",
      timezone: "UTC",
    })
    .run();
  db.insert(agents)
    .values({
      createdAt: now,
      createdBy: "u",
      id: "a",
      instructions: "",
      model: "fake",
      name: "A",
      runtime: "fake",
      runtimeConfig: "{}",
      slug: "a",
      status: "active",
      workspaceId: "w",
    })
    .run();
  db.insert(agentMailboxes)
    .values({
      address: "a@example.com",
      agentId: "a",
      createdAt: now,
      id: "box",
      status: "active",
      workspaceId: "w",
    })
    .run();
  ({ services } = composeWith({
    db,
    infra: {
      atomic: sqliteAtomic(db),
      blobs: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
      clock: systemClock,
      devFakeRuntime: false,
      fileBlobs: {
        delete: () => Promise.resolve(),
        get: () => Promise.resolve(null),
        put: () => Promise.resolve(),
      },
      mailbox: port,
      relay: noopRelay,
    },
  }));
});

test("a raw message reaches the mailbox port and is indexed", async () => {
  expect(await deliver("A@Example.com", plain)).toEqual([]);
  expect(stored).toHaveLength(1);
  expect(stored[0]?.subject).toBe("Hello");
  expect(stored[0]?.envelopeTo).toBe("a@example.com");
  expect(db.select().from(mailThreads).all()).toHaveLength(1);
});

test("a read receipt is dropped before anything is stored, which needs the report headers", async () => {
  expect(await deliver("a@example.com", readReceipt)).toEqual([]);
  expect(stored).toHaveLength(0);
  expect(db.select().from(mailThreads).all()).toHaveLength(0);
});

test("mail for an address without an active mailbox is rejected", async () => {
  expect(await deliver("nobody@example.com", plain)).toEqual([
    "Unknown address",
  ]);
  expect(stored).toHaveLength(0);
});
