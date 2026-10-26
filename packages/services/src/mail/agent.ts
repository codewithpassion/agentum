import type { Database } from "@repo/db";
import {
  agentMailboxes,
  mailMessages,
  mailThreads,
} from "@repo/db/schema/mail";
import { and, desc, eq, inArray } from "drizzle-orm";
import { authorize, ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import type { Principal } from "../workspaces.ts";
import type {
  MailboxPort,
  ThreadMessage,
  ThreadSummary,
  ThreadView,
} from "./types.ts";

/** A message of an agent's thread. `status` is the delivery or approval outcome from D1. */
export interface AgentThreadMessage extends ThreadMessage {
  status?: string;
}

export interface AgentThreadView {
  messages: AgentThreadMessage[];
  threadId: string;
}

/**
 * What a run's agent sees of its own mailbox. Thread and message ids are the D1
 * ids that `mail.send` and `mail.reply` also return and take, so an id from
 * `list` works in `reply`. The mailbox store keeps its own ids, which stay
 * behind this module.
 */
export const createMailAgent = ({
  db,
  mailbox,
}: {
  db: Database;
  mailbox?: MailboxPort;
}) => {
  const activeBox = async (principal: Principal) => {
    if (principal.kind !== "run") {
      throw new ForbiddenError("mail.read");
    }
    authorize(principal, "mail.read", {
      kind: "mailbox",
      workspaceId: principal.workspaceId,
    });
    const [box] = await db
      .select()
      .from(agentMailboxes)
      .where(
        and(
          eq(agentMailboxes.workspaceId, principal.workspaceId),
          eq(agentMailboxes.agentId, principal.agentId),
          eq(agentMailboxes.status, "active")
        )
      );
    return box ?? null;
  };
  const requirePort = (): MailboxPort => {
    if (!mailbox) {
      throw new ServiceError("invalid", "Mail is not set up here");
    }
    return mailbox;
  };

  /** Whether the run's agent has an active mailbox. The MCP route turns the mail tools on with it. */
  const hasActiveMailbox = async (principal: Principal): Promise<boolean> =>
    principal.kind === "run" && Boolean(await activeBox(principal));

  /** Whether an active mailbox owns this address. The inbound handler calls it before it reads a message. */
  const isActiveAddress = async (
    principal: Principal,
    address: string
  ): Promise<boolean> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError("mail.receive");
    }
    const [box] = await db
      .select({ id: agentMailboxes.id })
      .from(agentMailboxes)
      .where(
        and(
          eq(agentMailboxes.address, address.trim().toLowerCase()),
          eq(agentMailboxes.status, "active")
        )
      );
    return Boolean(box);
  };

  const listThreads = async (
    principal: Principal,
    page: { limit: number; page: number }
  ): Promise<ThreadSummary[]> => {
    const box = await activeBox(principal);
    if (!box) {
      throw new ServiceError("not_found", "Active mailbox not found");
    }
    const summaries = await requirePort().listThreads(
      { mailboxId: box.id, workspaceId: box.workspaceId },
      page
    );
    if (summaries.length === 0) {
      return [];
    }
    const rows = await db
      .select({ external: mailThreads.externalThreadId, id: mailThreads.id })
      .from(mailThreads)
      .where(
        and(
          eq(mailThreads.mailboxId, box.id),
          inArray(
            mailThreads.externalThreadId,
            summaries.map((s) => s.threadId)
          )
        )
      );
    const ids = new Map(rows.map((row) => [row.external, row.id]));
    // A thread with no D1 row cannot be read or replied to by id, so it stays out.
    return summaries.flatMap((summary) => {
      const id = ids.get(summary.threadId);
      return id ? [{ ...summary, threadId: id }] : [];
    });
  };

  const readThread = async (
    principal: Principal,
    threadId: string
  ): Promise<AgentThreadView | null> => {
    const box = await activeBox(principal);
    if (!box) {
      throw new ServiceError("not_found", "Active mailbox not found");
    }
    const [thread] = await db
      .select()
      .from(mailThreads)
      .where(
        and(eq(mailThreads.id, threadId), eq(mailThreads.mailboxId, box.id))
      );
    if (!thread) {
      return null;
    }
    const view: ThreadView | null = await requirePort().readThread(
      { mailboxId: box.id, workspaceId: box.workspaceId },
      thread.externalThreadId
    );
    if (!view) {
      return null;
    }
    const rows = await db
      .select({
        external: mailMessages.externalMessageId,
        id: mailMessages.id,
        status: mailMessages.status,
      })
      .from(mailMessages)
      .where(eq(mailMessages.threadId, thread.id))
      .orderBy(desc(mailMessages.createdAt));
    const byExternal = new Map(rows.map((row) => [row.external, row]));
    return {
      messages: view.messages.map((message) => {
        const row = byExternal.get(message.messageId);
        return row
          ? { ...message, messageId: row.id, status: row.status }
          : message;
      }),
      threadId: thread.id,
    };
  };

  return { hasActiveMailbox, isActiveAddress, listThreads, readThread };
};
