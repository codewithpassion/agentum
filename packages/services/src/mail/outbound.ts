import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import {
  agentMailboxes,
  mailMessages,
  mailThreads,
} from "@repo/db/schema/mail";
import { runRequests } from "@repo/db/schema/requests";
import { agentToolRules } from "@repo/db/schema/tool-rules";
import { workspaces } from "@repo/db/schema/workspaces";
import { MAIL_SEND_TOOL, mailToolKey } from "@repo/db/shared";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "../authz.ts";
import type { MemberDirectory } from "../desk-api.ts";
import { ServiceError } from "../errors.ts";
import type { EventRecord, EventsService } from "../events.ts";
import type { RequestsService } from "../requests.ts";
import { loadRun } from "../runs/queries.ts";
import type { Clock, RunRecord } from "../runs/types.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "../workspaces.ts";
import type {
  HeldMail,
  MailboxPort,
  MailboxRef,
  OutgoingDraft,
  SentMail,
} from "./types.ts";

const HEADER_NEWLINE = /[\r\n]/;
const address = z.string().trim().toLowerCase().pipe(z.email());
const draftSchema = z.strictObject({
  cc: z.array(address).default([]),
  from: address.optional(),
  html: z.string().optional(),
  subject: z
    .string()
    .max(998)
    .refine((value) => !HEADER_NEWLINE.test(value)),
  text: z.string(),
  to: z.array(address).min(1),
});
export type MailDraft = z.input<typeof draftSchema>;
type Message = typeof mailMessages.$inferSelect;
type Thread = typeof mailThreads.$inferSelect;
type Mailbox = typeof agentMailboxes.$inferSelect;

const sendDraft = async (
  adapter: MailboxPort,
  ref: MailboxRef,
  draft: OutgoingDraft,
  thread: Thread | undefined,
  held: boolean
): Promise<HeldMail | SentMail> => {
  if (held) {
    return await adapter.hold(ref, draft, thread?.externalThreadId);
  }
  if (thread) {
    return await adapter.reply(ref, thread.externalThreadId, draft);
  }
  return await adapter.send(ref, draft);
};

/** Outbound mail uses V1 approvals as durable decisions, without suspending a runtime. */
export const createMailOutbound = ({
  db,
  atomic,
  clock,
  events,
  requests,
  mailbox,
  memberDirectory,
}: {
  db: Database;
  atomic: Atomic;
  clock: Clock;
  events: EventsService;
  requests: Pick<RequestsService, "open" | "setRule">;
  mailbox?: MailboxPort;
  memberDirectory?: MemberDirectory;
}) => {
  const port = () => {
    if (!mailbox) {
      throw new ServiceError("invalid", "Mail is not set up here");
    }
    return mailbox;
  };
  const outsideRecipients = async (
    workspaceId: string,
    recipients: string[]
  ) => {
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!workspace) {
      throw new ServiceError("not_found", "Workspace not found");
    }
    const boxes = await db
      .select({ address: agentMailboxes.address })
      .from(agentMailboxes)
      .where(eq(agentMailboxes.workspaceId, workspaceId));
    const inside = new Set(boxes.map((box) => box.address.toLowerCase()));
    const unique = [...new Set(recipients)];
    const outside = await Promise.all(
      unique.map(async (recipient) =>
        inside.has(recipient) ||
        (await memberDirectory?.(recipient, workspace.clerkOrgId))
          ? null
          : recipient
      )
    );
    return outside.filter(
      (recipient): recipient is string => recipient !== null
    );
  };
  const announce = (
    message: Message,
    thread: Thread,
    box: Mailbox,
    type: "mail.held" | "mail.sent" | "mail.rejected" | "mail.expired"
  ) =>
    events.append({
      actor: { id: box.agentId, kind: "agent" },
      agentId: box.agentId,
      payload: {
        address: box.address,
        messageId: message.id,
        threadId: thread.id,
      },
      runId: message.runId,
      sessionId: thread.sessionId,
      type,
      workspaceId: message.workspaceId,
    });
  const sendContext = async (principal: Principal) => {
    if (principal.kind !== "run" || principal.dryRun) {
      throw new ForbiddenError("mail.send");
    }
    authorize(principal, "mail.send", {
      kind: "mailbox",
      workspaceId: principal.workspaceId,
    });
    const run = await loadRun(db, principal.runId, principal.workspaceId);
    if (
      !run ||
      run.agentId !== principal.agentId ||
      run.dryRun ||
      !["running", "waiting"].includes(run.status)
    ) {
      throw new ForbiddenError("mail.send");
    }
    const [box] = await db
      .select()
      .from(agentMailboxes)
      .where(
        and(
          eq(agentMailboxes.workspaceId, run.workspaceId),
          eq(agentMailboxes.agentId, run.agentId),
          eq(agentMailboxes.status, "active")
        )
      );
    if (!box) {
      throw new ServiceError("not_found", "Active mailbox not found");
    }
    return {
      box,
      ref: { mailboxId: box.id, workspaceId: box.workspaceId },
      run,
    };
  };
  const indexDelivery = async ({
    result,
    draft,
    box,
    run,
    thread,
    held,
  }: {
    result: SentMail | HeldMail;
    draft: OutgoingDraft;
    box: Mailbox;
    run: RunRecord;
    thread?: Thread;
    held: boolean;
  }) => {
    const now = clock.now().toISOString();
    const indexedThread: Thread = {
      externalThreadId: result.threadId,
      id: thread?.id ?? ulid(),
      lastMessageAt: now,
      mailboxId: box.id,
      sessionId: held ? (thread?.sessionId ?? null) : run.sessionId,
      subject: draft.subject,
      workspaceId: run.workspaceId,
    };
    const message: Message = {
      ccAddresses: JSON.stringify(draft.cc),
      createdAt: now,
      direction: "out",
      externalMessageId: result.messageId,
      fromAddress: JSON.stringify({ address: box.address }),
      id: ulid(),
      requestId: null,
      rfcMessageId: "rfcMessageId" in result ? result.rfcMessageId : null,
      runId: run.id,
      snippet: draft.text.slice(0, 500),
      status: held ? "held" : "sent",
      subject: draft.subject,
      threadId: indexedThread.id,
      toAddresses: JSON.stringify(draft.to),
      workspaceId: run.workspaceId,
    };
    // Tasks are sessions in V1. Only a sent thread follows the sending run's
    // task. The subquery also finds the winning id when thread creation races.
    const key = and(
      eq(mailThreads.mailboxId, box.id),
      eq(mailThreads.externalThreadId, result.threadId)
    );
    await atomic([
      db
        .insert(mailThreads)
        .values(indexedThread)
        .onConflictDoUpdate({
          set: {
            lastMessageAt: now,
            ...(held ? {} : { sessionId: run.sessionId }),
          },
          target: [mailThreads.mailboxId, mailThreads.externalThreadId],
        }),
      db.insert(mailMessages).values({
        ...message,
        threadId: sql`(${db.select({ id: mailThreads.id }).from(mailThreads).where(key)})`,
      }),
    ]);
    const [storedThread] = await db.select().from(mailThreads).where(key);
    if (!storedThread) {
      throw new ServiceError("not_found", "Thread not found");
    }
    return { message: { ...message, threadId: storedThread.id }, storedThread };
  };
  const deliver = async (
    principal: Principal,
    raw: MailDraft,
    threadId?: string
  ) => {
    const { box, run, ref } = await sendContext(principal);
    const input = draftSchema.parse(raw);
    if (input.from && input.from !== box.address.toLowerCase()) {
      throw new ForbiddenError("mail.send.from");
    }
    const draft: OutgoingDraft = { ...input, from: box.address };
    let thread: Thread | undefined;
    if (threadId) {
      [thread] = await db
        .select()
        .from(mailThreads)
        .where(
          and(
            eq(mailThreads.id, threadId),
            eq(mailThreads.mailboxId, box.id),
            eq(mailThreads.workspaceId, run.workspaceId)
          )
        );
      if (!thread) {
        throw new ServiceError("not_found", "Thread not found");
      }
    }
    const outside = await outsideRecipients(run.workspaceId, [
      ...draft.to,
      ...draft.cc,
    ]);
    const rules = await db
      .select()
      .from(agentToolRules)
      .where(
        and(
          eq(agentToolRules.workspaceId, run.workspaceId),
          eq(agentToolRules.agentId, run.agentId),
          eq(agentToolRules.mode, "allow")
        )
      );
    const allowed = new Set(rules.map((rule) => rule.toolKey));
    const unallowed = outside.find(
      (recipient) => !allowed.has(mailToolKey(recipient))
    );
    const adapter = port();
    const result = await sendDraft(
      adapter,
      ref,
      draft,
      thread,
      Boolean(unallowed)
    );
    const { message, storedThread } = await indexDelivery({
      box,
      draft,
      held: Boolean(unallowed),
      result,
      run,
      thread,
    });
    if (!unallowed) {
      await announce(
        message,
        { ...storedThread, sessionId: run.sessionId },
        box,
        "mail.sent"
      );
      return {
        messageId: message.id,
        rfcMessageId: message.rfcMessageId ?? "",
        status: "sent" as const,
        threadId: storedThread.id,
      };
    }
    // Announce before opening: onAppend can answer synchronously during requests.open.
    await announce(
      message,
      { ...storedThread, sessionId: run.sessionId },
      box,
      "mail.held"
    );
    let request: Awaited<ReturnType<RequestsService["open"]>>;
    try {
      request = await requests.open(SYSTEM_PRINCIPAL, {
        input: {
          cc: draft.cc,
          from: box.address,
          preview: draft.text.slice(0, 500),
          subject: draft.subject,
          to: draft.to,
        },
        kind: "approval",
        runId: run.id,
        toolKey: mailToolKey(unallowed),
        toolName: MAIL_SEND_TOOL,
        toolUseId: `mail:${message.id}`,
      });
    } catch (error) {
      // Without an approval nothing would ever release or drop the held mail.
      await failHeld(adapter, ref, message);
      throw error;
    }
    await atomic([
      db
        .update(mailMessages)
        .set({ requestId: request.id })
        .where(eq(mailMessages.id, message.id)),
    ]);
    return {
      message: "waiting for approval" as const,
      messageId: message.id,
      requestId: request.id,
      status: "held" as const,
      threadId: storedThread.id,
    };
  };
  const failHeld = async (
    adapter: MailboxPort,
    ref: MailboxRef,
    message: Message
  ) => {
    await adapter.discard(ref, message.externalMessageId);
    await atomic([
      db
        .update(mailMessages)
        .set({ status: "failed" })
        .where(eq(mailMessages.id, message.id)),
    ]);
  };
  const decisionContext = async (event: EventRecord) => {
    const { requestId } = event.payload;
    if (typeof requestId !== "string") {
      return null;
    }
    const [context] = await db
      .select({
        box: agentMailboxes,
        message: mailMessages,
        request: runRequests,
        thread: mailThreads,
      })
      .from(runRequests)
      .innerJoin(
        mailMessages,
        and(
          eq(mailMessages.runId, runRequests.runId),
          eq(runRequests.toolUseId, sql`'mail:' || ${mailMessages.id}`),
          eq(mailMessages.workspaceId, runRequests.workspaceId)
        )
      )
      .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
      .innerJoin(
        agentMailboxes,
        and(
          eq(agentMailboxes.id, mailThreads.mailboxId),
          eq(agentMailboxes.agentId, runRequests.agentId),
          eq(agentMailboxes.workspaceId, runRequests.workspaceId)
        )
      )
      .where(
        and(
          eq(runRequests.id, requestId),
          eq(runRequests.workspaceId, event.workspaceId),
          eq(runRequests.toolName, MAIL_SEND_TOOL),
          eq(mailMessages.status, "held")
        )
      );
    // The join matches the message id in the tool use, so an immediate answer
    // works before requests.open has returned its id to the sending call.
    return context ?? null;
  };
  const allowOtherRecipients = async (
    request: typeof runRequests.$inferSelect,
    message: Message
  ) => {
    if (!request.answeredBy) {
      return;
    }
    const outside = await outsideRecipients(request.workspaceId, [
      ...JSON.parse(message.toAddresses),
      ...JSON.parse(message.ccAddresses),
    ]);
    const user = {
      kind: "user",
      userId: request.answeredBy,
      via: "session",
      workspaceId: request.workspaceId,
    } as const;
    await Promise.all(
      outside
        .filter((recipient) => mailToolKey(recipient) !== request.toolKey)
        .map((recipient) =>
          requests.setRule(user, {
            agentId: request.agentId,
            mode: "allow",
            toolKey: mailToolKey(recipient),
          })
        )
    );
  };
  const releaseHeld = async (
    adapter: MailboxPort,
    ref: MailboxRef,
    requestId: string,
    message: Message
  ) => {
    try {
      return await adapter.release(ref, message.externalMessageId);
    } catch (error) {
      // The person allowed it but it never left. Say so in the message status
      // instead of leaving it held for good.
      await atomic([
        db
          .update(mailMessages)
          .set({ requestId, status: "failed" })
          .where(eq(mailMessages.id, message.id)),
      ]);
      throw error;
    }
  };
  const applyDecision = async ({
    request,
    message,
    thread,
    box,
  }: NonNullable<Awaited<ReturnType<typeof decisionContext>>>) => {
    const ref = { mailboxId: box.id, workspaceId: box.workspaceId };
    const decision = request.answer
      ? JSON.parse(request.answer).decision
      : null;
    const permitted =
      request.status === "answered" &&
      (decision === "allow_once" || decision === "always_allow");
    if (permitted && decision === "always_allow") {
      await allowOtherRecipients(request, message);
    }
    const adapter = port();
    const sent = permitted
      ? await releaseHeld(adapter, ref, request.id, message)
      : null;
    if (!permitted) {
      await adapter.discard(ref, message.externalMessageId);
    }
    const unsentStatus = request.status === "expired" ? "expired" : "rejected";
    const status = sent ? "sent" : unsentStatus;
    await atomic([
      db
        .update(mailMessages)
        .set({
          requestId: request.id,
          rfcMessageId: sent ? sent.rfcMessageId : null,
          status,
        })
        .where(eq(mailMessages.id, message.id)),
      ...(sent
        ? [
            db
              .update(mailThreads)
              .set({ sessionId: request.sessionId })
              .where(eq(mailThreads.id, thread.id)),
          ]
        : []),
    ]);
    await announce(
      message,
      { ...thread, sessionId: request.sessionId },
      box,
      `mail.${status}`
    );
  };
  events.onAppend(async (event) => {
    if (event.type !== "request.answered" && event.type !== "request.expired") {
      return;
    }
    const pendingDecision = await decisionContext(event);
    if (pendingDecision) {
      await applyDecision(pendingDecision);
    }
  });
  const today = async (principal: Principal) => {
    if (principal.kind !== "user") {
      throw new ForbiddenError("mail.today");
    }
    authorize(principal, "mail.today", {
      kind: "mailbox",
      workspaceId: principal.workspaceId,
    });
    const [workspace] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, principal.workspaceId));
    if (!workspace) {
      throw new ServiceError("not_found", "Workspace not found");
    }
    const boxes = await db
      .select()
      .from(agentMailboxes)
      .where(eq(agentMailboxes.workspaceId, workspace.id))
      .orderBy(agentMailboxes.address);
    const now = clock.now();
    // "Today" means the workspace's calendar day for both incoming and held mail;
    // held counts only messages still awaiting approval, not every historical hold.
    const day = new Intl.DateTimeFormat("en-CA", {
      timeZone: workspace.timezone,
    });
    const date = day.format(now);
    const rows = await db
      .select({
        createdAt: mailMessages.createdAt,
        direction: mailMessages.direction,
        mailboxId: mailThreads.mailboxId,
        status: mailMessages.status,
      })
      .from(mailMessages)
      .innerJoin(mailThreads, eq(mailThreads.id, mailMessages.threadId))
      .where(
        and(
          eq(mailMessages.workspaceId, workspace.id),
          gte(
            mailMessages.createdAt,
            new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString()
          ),
          lte(mailMessages.createdAt, now.toISOString())
        )
      );
    return boxes.map((box) => {
      const messages = rows.filter(
        (row) =>
          row.mailboxId === box.id &&
          day.format(new Date(row.createdAt)) === date
      );
      return {
        address: box.address,
        held: messages.filter((row) => row.status === "held").length,
        in: messages.filter((row) => row.direction === "in").length,
      };
    });
  };
  return {
    reply: (principal: Principal, threadId: string, draft: MailDraft) =>
      deliver(principal, draft, threadId),
    send: (principal: Principal, draft: MailDraft) => deliver(principal, draft),
    today,
  };
};
export type MailOutbound = ReturnType<typeof createMailOutbound>;
