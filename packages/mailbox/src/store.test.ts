// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0
//
// Modified by Harbourmaster: tests for the mailbox store against an in-memory
// SQLite database, with a fixed clock so every time boundary is exact.

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  type AttachmentInput,
  createMailboxStore,
  DO_MAX_BOUND_PARAMS,
  type EmailInput,
  type FolderId,
  type InboundInsert,
  type MailboxStore,
} from "./store.ts";
import { testMailboxDb } from "./test-db.ts";

type Db = ReturnType<typeof testMailboxDb>;

const NOW = new Date("2026-10-27T12:00:00.000Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const iso = (msAgo: number): string =>
  new Date(NOW.getTime() - msAgo).toISOString();

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}-${counter}`;
};

const email = (overrides: Partial<EmailInput> = {}): EmailInput => ({
  bcc: null,
  body: "Hello there",
  bodyIsHtml: false,
  cc: null,
  date: iso(HOUR),
  dedupeKey: null,
  emailReferences: null,
  id: nextId("mail"),
  inReplyTo: null,
  messageId: null,
  rawHeaders: null,
  recipient: "agent@example.com",
  sender: "person@example.org",
  subject: "Hello",
  threadId: null,
  ...overrides,
});

const inbound = (overrides: Partial<InboundInsert> = {}): InboundInsert => ({
  attachments: [],
  body: "Hello there",
  bodyIsHtml: false,
  cc: null,
  date: iso(HOUR),
  dedupeKey: nextId("key"),
  id: nextId("in"),
  inReplyTo: null,
  messageId: null,
  rawHeaders: null,
  recipient: "agent@example.com",
  references: [],
  sender: "person@example.org",
  subject: "Hello",
  ...overrides,
});

const file = (id: string): AttachmentInput => ({
  contentId: null,
  disposition: "attachment",
  filename: `${id}.pdf`,
  id,
  mimetype: "application/pdf",
  size: 1024,
});

const must = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) {
    throw new Error("expected a value");
  }
  return value;
};

const setup = (): { db: Db; store: MailboxStore } => {
  const db = testMailboxDb();
  return { db, store: createMailboxStore(db, { now: () => NOW }) };
};

const add = (
  store: MailboxStore,
  folder: FolderId,
  overrides: Partial<EmailInput> = {}
): string => {
  const mail = email(overrides);
  store.createEmail(folder, mail, []);
  return mail.id;
};

const countEmailsWithKey = (db: Db, key: string): number =>
  db.all<{ cnt: number }>(
    sql`SELECT COUNT(*) AS cnt FROM emails WHERE dedupe_key = ${key}`
  )[0]?.cnt ?? 0;

const countAttachments = (db: Db): number =>
  db.all<{ cnt: number }>(sql`SELECT COUNT(*) AS cnt FROM attachments`)[0]
    ?.cnt ?? 0;

describe("createEmail and getEmail", () => {
  test("round-trips a mail with its attachments", () => {
    const { store } = setup();
    const mail = email({
      id: "rt-1",
      subject: "Round trip",
      threadId: "th-rt",
    });
    store.createEmail("inbox", mail, [file("rt-att-1"), file("rt-att-2")]);

    const stored = must(store.getEmail("rt-1"));
    expect(stored.subject).toBe("Round trip");
    expect(stored.folderId).toBe("inbox");
    expect(stored.threadId).toBe("th-rt");
    expect(stored.attachments.map((a) => a.id).sort()).toEqual([
      "rt-att-1",
      "rt-att-2",
    ]);
    expect(stored.attachments[0]?.emailId).toBe("rt-1");
    expect(store.getEmail("missing")).toBeNull();
  });

  test("stores sent and draft mail as read and inbox mail as unread", () => {
    const { store } = setup();
    store.createEmail("sent", email({ id: "r-sent" }), []);
    store.createEmail("draft", email({ id: "r-draft" }), []);
    store.createEmail("inbox", email({ id: "r-inbox" }), []);

    expect(must(store.getEmail("r-sent")).read).toBe(true);
    expect(must(store.getEmail("r-draft")).read).toBe(true);
    expect(must(store.getEmail("r-inbox")).read).toBe(false);
  });

  test("getThreadEmails returns the thread in date order with attachments on their own mail", () => {
    const { store } = setup();
    store.createEmail(
      "inbox",
      email({ date: iso(HOUR), id: "newer", threadId: "th-order" }),
      [file("new-att")]
    );
    store.createEmail(
      "inbox",
      email({ date: iso(3 * HOUR), id: "older", threadId: "th-order" }),
      [file("old-att")]
    );
    add(store, "inbox", { threadId: "other-thread" });

    const thread = store.getThreadEmails("th-order");
    expect(thread.map((mail) => mail.id)).toEqual(["older", "newer"]);
    expect(thread[0]?.attachments.map((a) => a.id)).toEqual(["old-att"]);
    expect(thread[1]?.attachments.map((a) => a.id)).toEqual(["new-att"]);
  });
});

describe("insertInbound", () => {
  test("stores the mail in the inbox with a resolved thread", () => {
    const { store } = setup();
    const result = store.insertInbound(
      inbound({ attachments: [file("in-att")], id: "in-1" })
    );

    expect(result).toEqual({
      attachments: [{ ...file("in-att"), emailId: "in-1" }],
      duplicate: false,
      id: "in-1",
      threadId: "in-1",
    });
    const stored = must(store.getEmail("in-1"));
    expect(stored.folderId).toBe("inbox");
    expect(stored.read).toBe(false);
    expect(stored.threadId).toBe("in-1");
    expect(stored.attachments.map((a) => a.id)).toEqual(["in-att"]);
  });

  test("a second call with the same dedupe key hits the unique index and returns the first ids", () => {
    const { db, store } = setup();
    const original = store.insertInbound(
      inbound({
        attachments: [file("dup-att-1")],
        dedupeKey: "m1@ext.example",
        id: "first",
      })
    );
    const again = store.insertInbound(
      inbound({
        attachments: [file("dup-att-2"), file("dup-att-3")],
        dedupeKey: "m1@ext.example",
        id: "second",
      })
    );

    expect(original.duplicate).toBe(false);
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe("first");
    expect(again.threadId).toBe(original.threadId);
    expect(again.attachments.map((a) => a.id)).toEqual(["dup-att-1"]);
    expect(store.getEmail("second")).toBeNull();
    expect(countEmailsWithKey(db, "m1@ext.example")).toBe(1);
    expect(countAttachments(db)).toBe(1);
  });

  test("a sha256 dedupe key never becomes the message id", () => {
    const { store } = setup();
    store.insertInbound(
      inbound({ dedupeKey: "sha256:abc", id: "hash-1", messageId: null })
    );

    const stored = must(store.getEmail("hash-1"));
    expect(stored.dedupeKey).toBe("sha256:abc");
    expect(stored.messageId).toBeNull();
  });

  test("a reference to a stored message id joins that mail's thread", () => {
    const { store } = setup();
    add(store, "inbox", {
      id: "orig",
      messageId: "orig@ext.example",
      threadId: "thread-orig",
    });

    const result = store.insertInbound(
      inbound({ id: "reply-a", references: ["orig@ext.example"] })
    );
    expect(result.threadId).toBe("thread-orig");
    expect(must(store.getEmail("reply-a")).threadId).toBe("thread-orig");
  });

  test("a reference to a stored thread id joins that thread", () => {
    const { store } = setup();
    add(store, "inbox", {
      id: "thr-owner",
      messageId: "owner@ext.example",
      threadId: "thread-b",
    });

    const result = store.insertInbound(
      inbound({ id: "reply-b", references: ["thread-b"] })
    );
    expect(result.threadId).toBe("thread-b");
  });

  test("a reply to a thread the agent started joins that thread", () => {
    const { store } = setup();
    add(store, "sent", {
      id: "agent-sent",
      messageId: "agent-msg@agent.example",
      recipient: "person@example.org",
      sender: "agent@example.com",
      threadId: "agent-msg@agent.example",
    });

    const result = store.insertInbound(
      inbound({
        id: "reply-c",
        inReplyTo: "agent-msg@agent.example",
        references: ["agent-msg@agent.example"],
        sender: "person@example.org",
      })
    );
    expect(result.threadId).toBe("agent-msg@agent.example");
  });

  test("with no stored match, the first reference becomes the thread id", () => {
    const { store } = setup();
    const result = store.insertInbound(
      inbound({
        id: "new-refs",
        inReplyTo: "reply-to@ext.example",
        references: ["ref-1@ext.example", "ref-2@ext.example"],
        subject: "Brand new refs",
      })
    );
    expect(result.threadId).toBe("ref-1@ext.example");
  });

  test("with no references and no stored match, inReplyTo becomes the thread id", () => {
    const { store } = setup();
    const result = store.insertInbound(
      inbound({
        id: "new-reply",
        inReplyTo: "reply-to@ext.example",
        references: [],
        subject: "Brand new reply",
      })
    );
    expect(result.threadId).toBe("reply-to@ext.example");
  });

  test("with no ids at all, the mail's own id becomes the thread id", () => {
    const { store } = setup();
    const result = store.insertInbound(
      inbound({ id: "new-alone", inReplyTo: null, references: [] })
    );
    expect(result.threadId).toBe("new-alone");
  });
});

describe("findByDedupeKey", () => {
  test("returns null for an unknown key", () => {
    const { store } = setup();
    expect(store.findByDedupeKey("unknown@ext.example")).toBeNull();
  });

  test("returns the ids and attachments of a known key", () => {
    const { store } = setup();
    const stored = store.insertInbound(
      inbound({
        attachments: [file("find-att")],
        dedupeKey: "known@ext.example",
        id: "find-1",
      })
    );

    expect(store.findByDedupeKey("known@ext.example")).toEqual({
      attachments: [{ ...file("find-att"), emailId: "find-1" }],
      duplicate: true,
      id: "find-1",
      threadId: stored.threadId,
    });
  });
});

describe("findThreadBySubject", () => {
  const subjectThread = (
    store: MailboxStore,
    msAgo: number,
    subject = "Quarterly plan"
  ): void => {
    add(store, "inbox", {
      date: iso(msAgo),
      recipient: "agent@example.com",
      sender: "person@example.org",
      subject,
      threadId: "subject-thread",
    });
  };

  test("does not find a thread whose newest mail is 7 days and 1 minute old", () => {
    const { store } = setup();
    subjectThread(store, 7 * DAY + MINUTE);
    expect(
      store.findThreadBySubject("Quarterly plan", "person@example.org")
    ).toBeNull();
  });

  test("finds a thread whose newest mail is 7 days minus 1 minute old", () => {
    const { store } = setup();
    subjectThread(store, 7 * DAY - MINUTE);
    expect(
      store.findThreadBySubject("Quarterly plan", "person@example.org")
    ).toBe("subject-thread");
  });

  test("a mail 1 minute before the cutoff on the same UTC day does not match", () => {
    // The cutoff is 2026-10-20T12:00:00Z. 11:59Z is on the same UTC day.
    const { store } = setup();
    subjectThread(store, 7 * DAY + MINUTE);
    expect(
      store.findThreadBySubject("Quarterly plan", "person@example.org")
    ).toBeNull();
  });

  test("a mail 1 minute after the cutoff on the same UTC day matches", () => {
    // 12:01Z on 2026-10-20 is inside the window, on the same UTC day as 11:59Z.
    const { store } = setup();
    subjectThread(store, 7 * DAY - MINUTE);
    expect(
      store.findThreadBySubject("Quarterly plan", "person@example.org")
    ).toBe("subject-thread");
  });

  test("a Re: prefixed subject matches the stored subject", () => {
    const { store } = setup();
    subjectThread(store, HOUR);
    expect(
      store.findThreadBySubject("Re: Fwd: Quarterly plan", "person@example.org")
    ).toBe("subject-thread");
  });

  test("the sender must be a participant of the thread", () => {
    const { store } = setup();
    subjectThread(store, HOUR);
    expect(
      store.findThreadBySubject("Quarterly plan", "stranger@example.net")
    ).toBeNull();
    expect(
      store.findThreadBySubject("Quarterly plan", "agent@example.com")
    ).toBe("subject-thread");
  });

  test("an empty subject gives null", () => {
    const { store } = setup();
    subjectThread(store, HOUR, "");
    expect(store.findThreadBySubject("", "person@example.org")).toBeNull();
    expect(store.findThreadBySubject("Re: ", "person@example.org")).toBeNull();
  });
});

describe("checkSendRateLimit", () => {
  const addSent = (store: MailboxStore, count: number, msAgo: number) => {
    for (let i = 0; i < count; i += 1) {
      add(store, "sent", { date: iso(msAgo) });
    }
  };

  test("allows sending with 19 sent mails in the last hour", () => {
    const { store } = setup();
    addSent(store, 19, 10 * MINUTE);
    expect(store.checkSendRateLimit()).toBeNull();
  });

  test("refuses with the hour message at 20 sent mails 59 minutes ago", () => {
    const { store } = setup();
    addSent(store, 20, 59 * MINUTE);
    expect(store.checkSendRateLimit()).toBe(
      "Rate limit exceeded: max 20 emails per hour per mailbox"
    );
  });

  test("allows sending with 20 sent mails 61 minutes ago", () => {
    const { store } = setup();
    addSent(store, 20, 61 * MINUTE);
    expect(store.checkSendRateLimit()).toBeNull();
  });

  test("a sent mail exactly one hour old counts toward the hour limit", () => {
    const { store } = setup();
    addSent(store, 19, 10 * MINUTE);
    addSent(store, 1, HOUR);
    expect(store.checkSendRateLimit()).toBe(
      "Rate limit exceeded: max 20 emails per hour per mailbox"
    );
  });

  test("refuses with the day message at 100 sent mails spread over 23 hours", () => {
    const { store } = setup();
    // 100 mails, 13 minutes apart, from 23 hours ago to 93 minutes ago.
    // None falls in the last hour, so only the day limit can refuse.
    for (let i = 0; i < 100; i += 1) {
      add(store, "sent", { date: iso(23 * HOUR - i * 13 * MINUTE) });
    }
    expect(store.checkSendRateLimit()).toBe(
      "Rate limit exceeded: max 100 emails per day per mailbox"
    );
  });

  test("allows sending with 100 sent mails 25 hours ago", () => {
    const { store } = setup();
    addSent(store, 100, 25 * HOUR);
    expect(store.checkSendRateLimit()).toBeNull();
  });

  test("inbox and draft mails never count toward the limits", () => {
    const { store } = setup();
    for (let i = 0; i < 100; i += 1) {
      add(store, "inbox", { date: iso(5 * MINUTE) });
      add(store, "draft", { date: iso(5 * MINUTE) });
    }
    expect(store.checkSendRateLimit()).toBeNull();
  });
});

describe("listThreads", () => {
  test("groups mails with the same thread id into one row", () => {
    const { store } = setup();
    add(store, "inbox", { subject: "Same", threadId: "t-group" });
    add(store, "sent", { subject: "Same", threadId: "t-group" });

    const threads = store.listThreads({ limit: 10, page: 1 });
    expect(threads).toHaveLength(1);
    expect(threads[0]?.threadId).toBe("t-group");
    expect(threads[0]?.messageCount).toBe(2);
  });

  test("a mail without a thread id is its own thread keyed by its id", () => {
    const { store } = setup();
    const id = add(store, "inbox", { id: "solo-mail", threadId: null });

    const [thread] = store.listThreads({ limit: 10, page: 1 });
    expect(thread?.threadId).toBe(id);
    expect(thread?.messageCount).toBe(1);
  });

  test("lists the newest thread first", () => {
    const { store } = setup();
    add(store, "inbox", { date: iso(3 * HOUR), threadId: "ta" });
    add(store, "inbox", { date: iso(1 * HOUR), threadId: "tb" });
    add(store, "inbox", { date: iso(2 * HOUR), threadId: "tc" });

    const order = store
      .listThreads({ limit: 10, page: 1 })
      .map((thread) => thread.threadId);
    expect(order).toEqual(["tb", "tc", "ta"]);
  });

  test("counts only unread mails, so a sent reply does not add to unreadCount", () => {
    const { store } = setup();
    add(store, "inbox", { threadId: "t-unread" });
    add(store, "sent", { threadId: "t-unread" });

    const [thread] = store.listThreads({ limit: 10, page: 1 });
    expect(thread?.messageCount).toBe(2);
    expect(thread?.unreadCount).toBe(1);
  });

  test("participants are the distinct senders and recipients", () => {
    const { store } = setup();
    add(store, "inbox", {
      recipient: "agent@example.com, other@example.net",
      sender: "person@example.org",
      threadId: "t-people",
    });
    add(store, "sent", {
      recipient: "person@example.org",
      sender: "agent@example.com",
      threadId: "t-people",
    });

    const [thread] = store.listThreads({ limit: 10, page: 1 });
    expect([...(thread?.participants ?? [])].sort()).toEqual([
      "agent@example.com",
      "other@example.net",
      "person@example.org",
    ]);
  });

  test("the subject is the subject of the newest mail", () => {
    const { store } = setup();
    add(store, "inbox", {
      date: iso(5 * HOUR),
      subject: "Old subject",
      threadId: "t-subject",
    });
    add(store, "inbox", {
      date: iso(1 * HOUR),
      subject: "New subject",
      threadId: "t-subject",
    });

    const [thread] = store.listThreads({ limit: 10, page: 1 });
    expect(thread?.subject).toBe("New subject");
  });

  test("leaves out trash and spam, and drops a thread that is all trash", () => {
    const { store } = setup();
    add(store, "trash", { threadId: "t-trash" });
    add(store, "inbox", { threadId: "t-mixed" });
    add(store, "spam", { threadId: "t-mixed" });

    const threads = store.listThreads({ limit: 10, page: 1 });
    expect(threads.map((thread) => thread.threadId)).toEqual(["t-mixed"]);
    expect(threads[0]?.messageCount).toBe(1);
  });

  test("pages through threads, with page 0 read as page 1", () => {
    const { store } = setup();
    add(store, "inbox", { date: iso(1 * HOUR), threadId: "p1" });
    add(store, "inbox", { date: iso(2 * HOUR), threadId: "p2" });
    add(store, "inbox", { date: iso(3 * HOUR), threadId: "p3" });
    const ids = (page: number) =>
      store.listThreads({ limit: 2, page }).map((thread) => thread.threadId);

    expect(ids(1)).toEqual(["p1", "p2"]);
    expect(ids(2)).toEqual(["p3"]);
    expect(ids(0)).toEqual(["p1", "p2"]);
  });

  test("clamps the limit to 100 at most and to 1 at least", () => {
    const { store } = setup();
    for (let i = 1; i <= 101; i += 1) {
      add(store, "inbox", { date: iso(i * MINUTE), threadId: `c-${i}` });
    }
    expect(store.listThreads({ limit: 500, page: 1 })).toHaveLength(100);
    expect(store.listThreads({ limit: 500, page: 2 })).toHaveLength(1);
    expect(store.listThreads({ limit: 0, page: 1 })).toHaveLength(1);
    expect(store.listThreads({ limit: -4, page: 1 })).toHaveLength(1);
  });
});

describe("mail changes and deletes", () => {
  test("moveEmail moves a mail and reports false for an unknown id", () => {
    const { store } = setup();
    add(store, "inbox", { id: "mv-1" });

    expect(store.moveEmail("mv-1", "archive")).toBe(true);
    expect(must(store.getEmail("mv-1")).folderId).toBe("archive");
    expect(store.moveEmail("mv-missing", "trash")).toBe(false);
  });

  test("updateEmail changes read, date and messageId and returns the row", () => {
    const { store } = setup();
    add(store, "sent", { id: "up-1" });

    const updated = must(
      store.updateEmail("up-1", {
        date: iso(2 * MINUTE),
        messageId: "up-1@agent.example",
        read: false,
      })
    );
    expect(updated.id).toBe("up-1");
    expect(updated.read).toBe(false);
    expect(updated.date).toBe(iso(2 * MINUTE));
    expect(updated.messageId).toBe("up-1@agent.example");
    expect(store.updateEmail("up-missing", { read: true })).toBeNull();
  });

  test("deleteEmail returns the attachments and removes the mail and them", () => {
    const { store } = setup();
    store.createEmail("inbox", email({ id: "del-1" }), [
      file("del-att-1"),
      file("del-att-2"),
    ]);

    const removed = must(store.deleteEmail("del-1"));
    expect(removed.map((a) => a.id).sort()).toEqual(["del-att-1", "del-att-2"]);
    expect(store.getEmail("del-1")).toBeNull();
    expect(store.getAttachment("del-att-1")).toBeNull();
    expect(store.getAttachment("del-att-2")).toBeNull();
    expect(store.deleteEmail("del-1")).toBeNull();
  });

  test("getAttachment returns the row, or null for an unknown id", () => {
    const { store } = setup();
    store.createEmail("inbox", email({ id: "att-owner" }), [file("att-1")]);

    expect(store.getAttachment("att-1")).toEqual({
      contentId: null,
      disposition: "attachment",
      emailId: "att-owner",
      filename: "att-1.pdf",
      id: "att-1",
      mimetype: "application/pdf",
      size: 1024,
    });
    expect(store.getAttachment("att-missing")).toBeNull();
  });
});

describe("findThreadBySubject participants and thread starters", () => {
  test("matches whole addresses, not a part of one", () => {
    const { store } = setup();
    add(store, "inbox", {
      date: iso(HOUR),
      recipient: "agent@example.com",
      sender: "alice@corp.com",
      subject: "Plan",
      threadId: "plan-thread",
    });
    expect(store.findThreadBySubject("Re: Plan", "e@corp.co")).toBeNull();
    expect(store.findThreadBySubject("Re: Plan", "alice@corp.com")).toBe(
      "plan-thread"
    );
  });

  test("a thread that is one mail with its own id is not joined by subject", () => {
    const { store } = setup();
    add(store, "inbox", {
      date: iso(HOUR),
      id: "lonely",
      sender: "bob@x.com",
      subject: "Daily report",
      threadId: "lonely",
    });
    expect(store.findThreadBySubject("Daily report", "bob@x.com")).toBeNull();
  });
});

describe("bound parameters", () => {
  // A Durable Object's SQLite refuses a statement with more than 100 bound parameters.
  const guarded = (
    maxBoundParams = DO_MAX_BOUND_PARAMS
  ): { db: Db; store: MailboxStore } => {
    const db = testMailboxDb({ maxBoundParams });
    return {
      db,
      store: createMailboxStore(db, { maxBoundParams, now: () => NOW }),
    };
  };
  const files = (count: number, prefix: string): AttachmentInput[] =>
    Array.from({ length: count }, (_, index) => file(`${prefix}-${index}`));

  test("the guard rejects a statement above the limit", () => {
    const { db } = guarded();
    const ids = Array.from({ length: 101 }, (_, index) => `id-${index}`);
    expect(() =>
      db.all(sql`SELECT * FROM emails WHERE id IN (${sql.join(ids, sql`, `)})`)
    ).toThrow("bound parameters");
  });

  test("stores inbound mail with 20 attachments", () => {
    const { db, store } = guarded();
    const result = store.insertInbound(
      inbound({ attachments: files(20, "in-att"), id: "in-many" })
    );
    expect(result.attachments).toHaveLength(20);
    expect(countAttachments(db)).toBe(20);
    expect(must(store.getEmail("in-many")).attachments).toHaveLength(20);
  });

  test("stores a created mail with 20 attachments", () => {
    const { db, store } = guarded();
    store.createEmail("sent", email({ id: "out-many" }), files(20, "out-att"));
    expect(countAttachments(db)).toBe(20);
  });

  test("resolves a thread from a References header of 120 ids", () => {
    const { store } = guarded();
    store.createEmail(
      "inbox",
      email({ id: "root", messageId: "root@ext.example", threadId: "th-root" }),
      []
    );
    const references = [
      ...Array.from({ length: 119 }, (_, index) => `gone-${index}@ext.example`),
      "root@ext.example",
    ];
    const result = store.insertInbound(
      inbound({ id: "reply-120", references })
    );
    expect(result.threadId).toBe("th-root");
  });

  test("picks the newest match across id chunks", () => {
    const { store } = guarded();
    store.createEmail(
      "inbox",
      email({ date: iso(2 * DAY), id: "old", messageId: "old@ext.example" }),
      []
    );
    store.createEmail(
      "inbox",
      email({ date: iso(HOUR), id: "new", messageId: "new@ext.example" }),
      []
    );
    const ids = [
      "old@ext.example",
      ...Array.from({ length: 120 }, (_, index) => `gone-${index}`),
      "new@ext.example",
    ];
    expect(store.findThreadByIds(ids)).toBe("new");
  });

  test("reads back a thread of 150 messages with their attachments", () => {
    const { store } = guarded();
    for (let index = 0; index < 150; index += 1) {
      store.createEmail(
        "inbox",
        email({
          date: iso(DAY - index * MINUTE),
          id: `big-${index}`,
          threadId: "th-big",
        }),
        [file(`big-att-${index}`)]
      );
    }
    const thread = store.getThreadEmails("th-big");
    expect(thread).toHaveLength(150);
    expect(thread.every((mail) => mail.attachments.length === 1)).toBe(true);
  });

  test("chunks by the configured limit", () => {
    const { db, store } = guarded(30);
    store.createEmail("sent", email({ id: "small-limit" }), files(5, "sl"));
    expect(countAttachments(db)).toBe(5);
    expect(must(store.getEmail("small-limit")).attachments).toHaveLength(5);
  });
});
