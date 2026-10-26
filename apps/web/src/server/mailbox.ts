// The MailboxDO Durable Object (`idFromName(mailboxId)`), where mailboxId is the
// agent_mailboxes row id. It holds one agent mailbox's mail in its SQLite.
// The logic lives in @repo/mailbox/store. This class only wires storage, runs
// the migrations and exposes the store over RPC.
import { DurableObject } from "cloudflare:workers";
import { applyMigrations } from "@repo/mailbox/migrations";
import {
  type AttachmentInput,
  type AttachmentRow,
  createMailboxStore,
  type EmailChanges,
  type EmailInput,
  type FolderId,
  type InboundInsert,
  type InboundResult,
  type MailboxStore,
  type StoredEmail,
} from "@repo/mailbox/store";
import type { ThreadSummary } from "@repo/services/mail/types";
import { drizzle } from "drizzle-orm/durable-sqlite";

export class MailboxDO extends DurableObject<Env> {
  readonly #store: MailboxStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const db = drizzle(ctx.storage);
    applyMigrations(db);
    this.#store = createMailboxStore(db);
  }

  checkSendRateLimit(): string | null {
    return this.#store.checkSendRateLimit();
  }

  createEmail(
    folder: FolderId,
    email: EmailInput,
    files: AttachmentInput[]
  ): void {
    this.#store.createEmail(folder, email, files);
  }

  deleteEmail(id: string): AttachmentRow[] | null {
    return this.#store.deleteEmail(id);
  }

  findByDedupeKey(key: string): InboundResult | null {
    return this.#store.findByDedupeKey(key);
  }

  findThreadByIds(ids: string[]): string | null {
    return this.#store.findThreadByIds(ids);
  }

  findThreadBySubject(subject: string, senderAddress: string): string | null {
    return this.#store.findThreadBySubject(subject, senderAddress);
  }

  getAttachment(id: string): AttachmentRow | null {
    return this.#store.getAttachment(id);
  }

  getEmail(id: string): StoredEmail | null {
    return this.#store.getEmail(id);
  }

  getThreadEmails(threadId: string): StoredEmail[] {
    return this.#store.getThreadEmails(threadId);
  }

  insertInbound(input: InboundInsert): InboundResult {
    return this.#store.insertInbound(input);
  }

  listThreads(page: { limit: number; page: number }): ThreadSummary[] {
    return this.#store.listThreads(page);
  }

  moveEmail(id: string, folder: FolderId): boolean {
    return this.#store.moveEmail(id, folder);
  }

  updateEmail(id: string, changes: EmailChanges): StoredEmail | null {
    return this.#store.updateEmail(id, changes);
  }
}
