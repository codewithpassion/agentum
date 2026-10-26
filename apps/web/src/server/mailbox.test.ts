import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MAILBOX_MIGRATIONS } from "@repo/mailbox/migrations";
import type { InboundInsert } from "@repo/mailbox/store";
import { MailboxDO } from "./mailbox.ts";

type Row = Record<string, unknown>;

/**
 * The storage of a Durable Object, backed by bun:sqlite. It has the two
 * surfaces the drizzle driver calls: `sql.exec` and `transactionSync`.
 */
const fakeState = (client: Database) => {
  const storage = {
    sql: {
      exec(query: string, ...bindings: SQLQueryBindings[]) {
        const statement = client.query(query);
        const arrays =
          (statement.values(...bindings) as unknown[][] | null) ?? [];
        const names = statement.columnNames;
        const rows: Row[] = arrays.map((array) =>
          Object.fromEntries(names.map((name, index) => [name, array[index]]))
        );
        return {
          [Symbol.iterator]: () => rows[Symbol.iterator](),
          next: () =>
            rows.length > 0
              ? { done: false, value: rows[0] }
              : { done: true, value: undefined },
          raw: () => ({ toArray: () => arrays }),
          toArray: () => rows,
        };
      },
    },
    transactionSync: <T>(fn: () => T): T => client.transaction(fn)(),
  };
  return { storage } as unknown as DurableObjectState;
};

const env = {} as unknown as Env;

const inbound: InboundInsert = {
  attachments: [],
  body: "Hello there",
  bodyIsHtml: false,
  cc: null,
  date: "2026-10-27T10:00:00.000Z",
  dedupeKey: "dedupe-1",
  id: "email-1",
  inReplyTo: null,
  messageId: "<msg-1@example.com>",
  rawHeaders: null,
  recipient: "agent@example.com",
  references: [],
  sender: "person@example.com",
  subject: "Hello",
};

describe("MailboxDO", () => {
  test("stores an inbound mail on the drizzle Durable Object driver", () => {
    const client = new Database(":memory:");
    const mailbox = new MailboxDO(fakeState(client), env);

    const first = mailbox.insertInbound(inbound);
    expect(first.duplicate).toBe(false);
    expect(first.id).toBe("email-1");

    const thread = mailbox.getThreadEmails(first.threadId);
    expect(thread.map((email) => email.id)).toEqual(["email-1"]);

    expect(mailbox.listThreads({ limit: 10, page: 1 })).toHaveLength(1);
  });

  test("answers a second delivery with the stored mail", () => {
    const client = new Database(":memory:");
    const mailbox = new MailboxDO(fakeState(client), env);
    const first = mailbox.insertInbound(inbound);

    const again = mailbox.insertInbound({ ...inbound, id: "email-2" });
    expect(again.duplicate).toBe(true);
    expect(again.id).toBe(first.id);
  });

  test("does not run the migrations again on a second start", () => {
    const client = new Database(":memory:");
    const state = fakeState(client);
    const mailbox = new MailboxDO(state, env);
    mailbox.insertInbound(inbound);

    const restarted = new MailboxDO(state, env);
    expect(restarted.listThreads({ limit: 10, page: 1 })).toHaveLength(1);

    const [count] = client
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM mailbox_migrations"
      )
      .all();
    expect(count?.count).toBe(MAILBOX_MIGRATIONS.length);
  });
});
