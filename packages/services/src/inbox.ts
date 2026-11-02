/**
 * The inbox: threads anyone in the workspace can read and post to. A post
 * that mentions `@slug` wakes that agent with a run whose reply lands back in
 * the thread. A person's post wakes agents as that person. An agent's reply
 * wakes agents with a run principal for the replying run, so the person the
 * chain is for comes from the run table and never from the post's text. The
 * loop guard (`inbox/loop-guard.ts`) keeps two agents from talking forever.
 * `gateway` is what `completeRun` hands an agent's reply to.
 */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { inboxPosts, inboxThreads } from "@repo/db/schema/inbox";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import type { InboxAuthorKind } from "@repo/db/shared";
import { and, desc, eq, gt, inArray, lt } from "drizzle-orm";
import { monotonicFactory } from "ulidx";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { isServiceError, ServiceError } from "./errors.ts";
import type { EventsService } from "./events.ts";
import {
  AGENT_STREAK_LIMIT,
  checkWakeRate,
  streakSuppressed,
  WAKE_LIMIT_WINDOW_MS,
} from "./inbox/loop-guard.ts";
import { parseMentions } from "./inbox/mentions.ts";
import { buildWakeInput, WAKE_CONTEXT_POSTS } from "./inbox/wake-input.ts";
import { loadRun } from "./runs/queries.ts";
import {
  type Clock,
  type DeliveryContext,
  type Gateway,
  INPUT_TEXT_MAX,
  type ReplyTarget,
} from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import type { Principal } from "./workspaces.ts";

const READ_ACTION = "inbox.read";
const POST_ACTION = "inbox.post";
const INBOX_KIND = "inbox";
const TITLE_MAX = 120;
/** Threads one list call returns, most recently posted to first. */
export const THREAD_LIST_LIMIT = 50;
/** Posts one read returns: the newest ones, oldest first. */
export const THREAD_READ_LIMIT = 500;

/** Ids that sort in creation order even within one millisecond or when the clock steps back. */
const nextId = monotonicFactory();

const idString = z.string().min(1).max(200);

export const threadCreateInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(TITLE_MAX),
});
export type ThreadCreateInput = z.input<typeof threadCreateInputSchema>;

export const threadReadInputSchema = z.strictObject({ threadId: idString });

export const clearAttentionInputSchema = z.strictObject({
  threadId: idString,
});
export type ClearAttentionInput = z.input<typeof clearAttentionInputSchema>;

export const postInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(INPUT_TEXT_MAX),
  threadId: idString,
});
export type PostInput = z.input<typeof postInputSchema>;

export interface ThreadRecord {
  /** When a person last dismissed the thread from Needs you, or null. */
  attentionClearedAt: string | null;
  createdAt: string;
  createdBy: string;
  id: string;
  lastPostAt: string;
  title: string;
}

export interface PostRecord {
  /** The user id, or the agent id. */
  authorId: string;
  authorKind: InboxAuthorKind;
  createdAt: string;
  fileIds: string[];
  id: string;
  /** Set on an agent's post: the run that wrote it. */
  runId: string | null;
  text: string;
  threadId: string;
}

export interface ThreadView {
  posts: PostRecord[];
  thread: ThreadRecord;
}

/** A run a mention started. */
export interface WokenRun {
  agentId: string;
  runId: string;
}

export interface PostResult {
  post: PostRecord;
  runs: WokenRun[];
}

/** Why a wake did not happen, as `inbox.loop_stopped` records it. */
type StopReason = "budget" | "refused" | "streak";

type UserPrincipal = Extract<Principal, { kind: "user" }>;
type RunPrincipal = Extract<Principal, { kind: "run" }>;
type Member = UserPrincipal | RunPrincipal;
type ThreadRow = typeof inboxThreads.$inferSelect;
type PostRow = typeof inboxPosts.$inferSelect;

interface Author {
  id: string;
  kind: InboxAuthorKind;
}

/** Where an agent's post came from, for the event that records it. */
interface PostOrigin {
  runId: string;
  sessionId: string;
}

const toThread = (row: ThreadRow): ThreadRecord => ({
  attentionClearedAt: row.attentionClearedAt,
  createdAt: row.createdAt,
  createdBy: row.createdBy,
  id: row.id,
  lastPostAt: row.lastPostAt,
  title: row.title,
});

const toPost = (row: PostRow): PostRecord => ({
  authorId: row.authorId,
  authorKind: row.authorKind,
  createdAt: row.createdAt,
  fileIds: z.array(z.string()).parse(JSON.parse(row.fileIds)),
  id: row.id,
  runId: row.runId,
  text: row.text,
  threadId: row.threadId,
});

const requireMember = (principal: Principal, action: string): Member => {
  if (principal.kind !== "user" && principal.kind !== "run") {
    throw new ForbiddenError(action);
  }
  return principal;
};

/** Writing is for a person or a run. A read-only API key or OAuth client only reads. */
const requireWriter = (principal: Principal): Member => {
  const member = requireMember(principal, POST_ACTION);
  if (
    member.kind === "user" &&
    (member.apiKey?.access === "read" || member.oauthClient?.access === "read")
  ) {
    throw new ForbiddenError(POST_ACTION);
  }
  return member;
};

export interface InboxServiceOptions {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  /** Only `startRun` is used. The composition root passes it lazily, because the runs service is built with this service's gateway. */
  runs: Pick<RunsService, "startRun">;
}

export const createInboxService = ({
  atomic,
  clock,
  db,
  events,
  runs,
}: InboxServiceOptions) => {
  const findThread = async (
    threadId: string,
    workspaceId: string
  ): Promise<ThreadRow | null> => {
    const [row] = await db
      .select()
      .from(inboxThreads)
      .where(
        and(
          eq(inboxThreads.id, threadId),
          eq(inboxThreads.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return row ?? null;
  };

  const requireThread = async (
    member: Member,
    threadId: string,
    action: string
  ): Promise<ThreadRow> => {
    authorize(member, action, {
      id: threadId,
      kind: INBOX_KIND,
      workspaceId: member.workspaceId,
    });
    const thread = await findThread(threadId, member.workspaceId);
    if (!thread) {
      throw new ServiceError("not_found", "Thread not found");
    }
    return thread;
  };

  const createThread = async (
    principal: Principal,
    rawInput: ThreadCreateInput
  ): Promise<ThreadRecord> => {
    const input = threadCreateInputSchema.parse(rawInput);
    const writer = requireWriter(principal);
    if (writer.kind !== "user") {
      throw new ForbiddenError("inbox.create");
    }
    authorize(writer, "inbox.create", {
      kind: INBOX_KIND,
      workspaceId: writer.workspaceId,
    });
    const created = clock.now().toISOString();
    const row: ThreadRow = {
      attentionClearedAt: null,
      attentionClearedBy: null,
      createdAt: created,
      createdBy: writer.userId,
      id: nextId(clock.now().getTime()),
      lastPostAt: created,
      title: input.title,
      workspaceId: writer.workspaceId,
    };
    await db.insert(inboxThreads).values(row);
    return toThread(row);
  };

  const listThreads = async (principal: Principal): Promise<ThreadRecord[]> => {
    const member = requireMember(principal, READ_ACTION);
    authorize(member, READ_ACTION, {
      kind: INBOX_KIND,
      workspaceId: member.workspaceId,
    });
    const rows = await db
      .select()
      .from(inboxThreads)
      .where(eq(inboxThreads.workspaceId, member.workspaceId))
      .orderBy(desc(inboxThreads.lastPostAt), desc(inboxThreads.id))
      .limit(THREAD_LIST_LIMIT);
    return rows.map(toThread);
  };

  const readThread = async (
    principal: Principal,
    rawInput: z.input<typeof threadReadInputSchema>
  ): Promise<ThreadView> => {
    const { threadId } = threadReadInputSchema.parse(rawInput);
    const member = requireMember(principal, READ_ACTION);
    const thread = await requireThread(member, threadId, READ_ACTION);
    const rows = await db
      .select()
      .from(inboxPosts)
      .where(eq(inboxPosts.threadId, thread.id))
      .orderBy(desc(inboxPosts.id))
      .limit(THREAD_READ_LIMIT);
    return { posts: rows.reverse().map(toPost), thread: toThread(thread) };
  };

  /**
   * A person dismisses a thread from Needs you. It stays out until an agent
   * posts again. Dismissing twice moves the time forward.
   */
  const clearAttention = async (
    principal: Principal,
    rawInput: ClearAttentionInput
  ): Promise<ThreadRecord> => {
    const { threadId } = clearAttentionInputSchema.parse(rawInput);
    const writer = requireWriter(principal);
    if (writer.kind !== "user") {
      throw new ForbiddenError(POST_ACTION);
    }
    const thread = await requireThread(writer, threadId, POST_ACTION);
    const cleared: Pick<
      ThreadRow,
      "attentionClearedAt" | "attentionClearedBy"
    > = {
      attentionClearedAt: clock.now().toISOString(),
      attentionClearedBy: writer.userId,
    };
    await db
      .update(inboxThreads)
      .set(cleared)
      .where(eq(inboxThreads.id, thread.id));
    return toThread({ ...thread, ...cleared });
  };

  /** The post and the thread's `lastPostAt` in one atomic write, then `inbox.posted`. */
  const writePost = async (
    thread: ThreadRow,
    author: Author,
    body: { fileIds: readonly string[]; text: string },
    origin: PostOrigin | null
  ): Promise<PostRecord> => {
    const now = clock.now();
    const created = now.toISOString();
    const row: PostRow = {
      authorId: author.id,
      authorKind: author.kind,
      createdAt: created,
      fileIds: JSON.stringify(body.fileIds),
      id: nextId(now.getTime()),
      runId: origin ? origin.runId : null,
      text: body.text,
      threadId: thread.id,
      workspaceId: thread.workspaceId,
    };
    await atomic([
      db.insert(inboxPosts).values(row),
      db
        .update(inboxThreads)
        .set({ lastPostAt: created })
        .where(eq(inboxThreads.id, thread.id)),
    ]);
    await events.append({
      actor: { id: author.id, kind: author.kind },
      agentId: author.kind === "agent" ? author.id : null,
      payload: { postId: row.id, threadId: thread.id },
      runId: origin ? origin.runId : null,
      sessionId: origin ? origin.sessionId : null,
      type: "inbox.posted",
      workspaceId: thread.workspaceId,
    });
    return toPost(row);
  };

  /** The active agents the post names, in mention order. An agent does not wake itself. */
  const mentionedAgents = async (entry: PostRecord, workspaceId: string) => {
    const slugs = parseMentions(entry.text);
    if (slugs.length === 0) {
      return [];
    }
    const rows = await db
      .select({ id: agents.id, slug: agents.slug })
      .from(agents)
      .where(
        and(
          eq(agents.workspaceId, workspaceId),
          eq(agents.status, "active"),
          inArray(agents.slug, slugs)
        )
      );
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    return slugs.flatMap((slug) => {
      const agent = bySlug.get(slug);
      return agent && agent.id !== entry.authorId ? [agent] : [];
    });
  };

  /** True when the thread's newest posts are all from agents. */
  const streakReached = async (threadId: string): Promise<boolean> => {
    const recent = await db
      .select({ authorKind: inboxPosts.authorKind })
      .from(inboxPosts)
      .where(eq(inboxPosts.threadId, threadId))
      .orderBy(desc(inboxPosts.id))
      .limit(AGENT_STREAK_LIMIT);
    return streakSuppressed(recent.map((row) => row.authorKind));
  };

  /** True when the agent has used its wake budget for the past hour. */
  const budgetSpent = async (
    agentId: string,
    workspaceId: string
  ): Promise<boolean> => {
    const now = clock.now().getTime();
    // A wake is a run in an inbox session, so the run table is the ledger.
    const woken = await db
      .select({ createdAt: runRows.createdAt })
      .from(runRows)
      .innerJoin(sessions, eq(runRows.sessionId, sessions.id))
      .where(
        and(
          eq(runRows.workspaceId, workspaceId),
          eq(runRows.agentId, agentId),
          eq(sessions.origin, "inbox"),
          gt(
            runRows.createdAt,
            new Date(now - WAKE_LIMIT_WINDOW_MS).toISOString()
          )
        )
      );
    return !checkWakeRate(
      woken.map((row) => Date.parse(row.createdAt)),
      now
    ).allowed;
  };

  /** The posts before `entry`, oldest first, as many as a wake input can show. */
  const earlierPosts = async (thread: ThreadRow, entry: PostRecord) => {
    const rows = await db
      .select({
        authorId: inboxPosts.authorId,
        authorKind: inboxPosts.authorKind,
        text: inboxPosts.text,
      })
      .from(inboxPosts)
      .where(
        and(eq(inboxPosts.threadId, thread.id), lt(inboxPosts.id, entry.id))
      )
      .orderBy(desc(inboxPosts.id))
      .limit(WAKE_CONTEXT_POSTS);
    return rows.reverse();
  };

  const recordStop = (
    waker: Member,
    thread: ThreadRow,
    entry: PostRecord,
    agentId: string,
    reason: StopReason,
    message?: string
  ) =>
    events.append({
      actor:
        waker.kind === "user"
          ? { id: waker.userId, kind: "user" }
          : { id: waker.agentId, kind: "agent" },
      agentId,
      payload: {
        postId: entry.id,
        reason,
        threadId: thread.id,
        ...(message === undefined ? {} : { message }),
      },
      type: "inbox.loop_stopped",
      workspaceId: thread.workspaceId,
    });

  /** One mentioned agent: the guard first, then the run. Null when the wake was stopped. */
  const wakeOne = async (
    waker: Member,
    thread: ThreadRow,
    entry: PostRecord,
    target: { id: string },
    streak: boolean
  ): Promise<WokenRun | null> => {
    let stop: StopReason | null = null;
    if (streak) {
      stop = "streak";
    } else if (await budgetSpent(target.id, thread.workspaceId)) {
      stop = "budget";
    }
    if (stop) {
      await recordStop(waker, thread, entry, target.id, stop);
      return null;
    }
    try {
      const result = await runs.startRun(waker, {
        agentId: target.id,
        input: {
          text: buildWakeInput({
            earlier: await earlierPosts(thread, entry),
            text: entry.text,
            threadId: thread.id,
          }),
        },
        reply: { kind: "inbox", threadId: thread.id },
        session: { externalKey: thread.id, origin: "inbox" },
      });
      return { agentId: target.id, runId: result.runId };
    } catch (error) {
      // A refusal such as a busy ancestor or the depth limit stops this wake
      // only. The post stays, and so do the other wakes.
      if (!isServiceError(error)) {
        throw error;
      }
      await recordStop(
        waker,
        thread,
        entry,
        target.id,
        "refused",
        error.message
      );
      return null;
    }
  };

  /**
   * Starts a run for each agent the post mentions, as `waker`: the person for
   * their own post, the run principal for an agent's reply. Runs go one after
   * another because a run can finish, and post, inside `startRun`.
   */
  const wake = async (
    waker: Member,
    thread: ThreadRow,
    entry: PostRecord
  ): Promise<WokenRun[]> => {
    const targets = await mentionedAgents(entry, thread.workspaceId);
    if (targets.length === 0) {
      return [];
    }
    const streak = await streakReached(thread.id);
    const started: WokenRun[] = [];
    for (const target of targets) {
      // biome-ignore lint/performance/noAwaitInLoops: a wake can post and wake again, so they stay in order
      const woken = await wakeOne(waker, thread, entry, target, streak);
      if (woken) {
        started.push(woken);
      }
    }
    return started;
  };

  /**
   * A person (or a run, for the `inbox_post` tool) posts to a thread. The
   * result lists the runs its mentions started.
   */
  const post = async (
    principal: Principal,
    rawInput: PostInput
  ): Promise<PostResult> => {
    const input = postInputSchema.parse(rawInput);
    const writer = requireWriter(principal);
    const thread = await requireThread(writer, input.threadId, POST_ACTION);
    if (writer.kind === "user") {
      const written = await writePost(
        thread,
        { id: writer.userId, kind: "user" },
        { fileIds: [], text: input.text },
        null
      );
      return { post: written, runs: await wake(writer, thread, written) };
    }
    const run = await loadRun(db, writer.runId, writer.workspaceId);
    if (!run) {
      throw new ServiceError("not_found", "Run not found");
    }
    const written = await writePost(
      thread,
      { id: writer.agentId, kind: "agent" },
      { fileIds: [], text: input.text },
      { runId: run.id, sessionId: run.sessionId }
    );
    return { post: written, runs: await wake(writer, thread, written) };
  };

  const deliver = async (
    target: ReplyTarget,
    message: { fileIds: string[]; text: string },
    context: DeliveryContext
  ): Promise<void> => {
    if (target.kind !== "inbox") {
      throw new ServiceError("invalid", "Not an inbox reply target");
    }
    // The run row is the trusted source for the workspace and the session.
    const run = await loadRun(db, context.runId);
    if (!run) {
      throw new ServiceError("not_found", "Run not found");
    }
    const thread = await findThread(target.threadId, run.workspaceId);
    if (!thread) {
      throw new ServiceError("not_found", "Thread not found");
    }
    const written = await writePost(
      thread,
      { id: context.agentId, kind: "agent" },
      message,
      { runId: run.id, sessionId: run.sessionId }
    );
    await wake(
      {
        agentId: context.agentId,
        kind: "run",
        runId: run.id,
        workspaceId: run.workspaceId,
      },
      thread,
      written
    );
  };

  const gateway: Gateway = { deliver, kind: "inbox" };

  return {
    clearAttention,
    createThread,
    gateway,
    listThreads,
    post,
    readThread,
  };
};

export type InboxService = ReturnType<typeof createInboxService>;
