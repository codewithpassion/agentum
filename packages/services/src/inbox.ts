/**
 * The inbox: team rooms made of topics (threads). The Everyone team is open to
 * the whole workspace. Posting in another team's room needs team membership,
 * and a topic with member rows (`inbox_thread_members`) is visible to those
 * members only. A post that mentions `@slug` wakes that agent with a run whose
 * reply lands back in the thread. A person's post that mentions no agent wakes
 * the team's lead when the team's `lead_listens` is on. A person's post wakes agents as that person. An agent's reply
 * wakes agents with a run principal for the replying run, so the person the
 * chain is for comes from the run table and never from the post's text. The
 * loop guard (`inbox/loop-guard.ts`) keeps two agents from talking forever.
 * `gateway` is what `completeRun` hands an agent's reply to.
 */

import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import {
  inboxPosts,
  inboxThreadMembers,
  inboxThreads,
} from "@repo/db/schema/inbox";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { teams } from "@repo/db/schema/teams";
import {
  EVERYONE_TEAM_SLUG,
  type InboxAuthorKind,
  TEAM_MEMBER_KINDS,
} from "@repo/db/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  lt,
  notExists,
  sql,
} from "drizzle-orm";
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
import {
  type ArtifactLink,
  type PostLinks,
  postLinks,
} from "./inbox/post-links.ts";
import {
  canPostInTopic,
  canReadTopic,
  isInTeam,
  type Roomer,
  topicVisibleTo,
} from "./inbox/room-access.ts";
import { buildWakeInput } from "./inbox/wake-input.ts";
import { loadRun } from "./runs/queries.ts";
import {
  type Clock,
  type DeliveryContext,
  type Gateway,
  INPUT_TEXT_MAX,
  type ReplyTarget,
} from "./runs/types.ts";
import type { RunsService } from "./runs.ts";
import { idString } from "./shared.ts";
import { createDiscussionRounds } from "./teams/discussions.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

const READ_ACTION = "inbox.read";
const POST_ACTION = "inbox.post";
const NOTICE_ACTION = "inbox.notice";
/** The author id of a notice no agent wrote. */
const SYSTEM_AUTHOR_ID = "system";
const NOTICE_TEXT_MAX = 20_000;
const INBOX_KIND = "inbox";
const TITLE_MAX = 120;
const MEMBERS_MAX = 50;
/** Rows one catch-up reads. The wake input's character budget keeps far fewer. */
const WAKE_CATCH_UP_READ_LIMIT = 200;
/** Threads one list call returns, most recently posted to first. */
export const THREAD_LIST_LIMIT = 50;
/** Posts one read returns: the newest ones, oldest first. */
export const THREAD_READ_LIMIT = 500;

/** Ids that sort in creation order even within one millisecond or when the clock steps back. */
const nextId = monotonicFactory();

export const threadCreateInputSchema = z.strictObject({
  /** Limits the topic to these members. The person who opens it is always in. */
  members: z
    .array(
      z.strictObject({
        id: idString,
        kind: z.enum(TEAM_MEMBER_KINDS),
      })
    )
    .max(MEMBERS_MAX)
    .optional(),
  /** The team room to open the topic in. Defaults to the workspace's Everyone team. */
  teamId: idString.optional(),
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

/** A notice the system posts into a team room. */
export const noticeInputSchema = z.strictObject({
  /** The agent that wrote it, or null for a notice no agent wrote. */
  authorAgentId: idString.nullable(),
  teamId: idString,
  text: z.string().trim().min(1).max(NOTICE_TEXT_MAX),
  title: z.string().trim().min(1).max(TITLE_MAX),
  /** Wakes one agent, as this person, after the notice is posted. */
  wake: z.strictObject({ agentId: idString, asUserId: idString }).optional(),
});
export type NoticeInput = z.input<typeof noticeInputSchema>;

export interface ThreadRecord {
  /** When a person last dismissed the thread from Needs you, or null. */
  attentionClearedAt: string | null;
  createdAt: string;
  createdBy: string;
  id: string;
  lastPostAt: string;
  /** The team room the topic belongs to, or null for a topic from before teams. */
  teamId: string | null;
  title: string;
}

export interface PostRecord {
  /** Artifacts the post's run wrote, when the reader may see that run. */
  artifacts: ArtifactLink[];
  /** The user id, or the agent id. */
  authorId: string;
  authorKind: InboxAuthorKind;
  createdAt: string;
  /** Empty when the post's run is hidden from the reader. */
  fileIds: string[];
  id: string;
  /** Set on an agent's post: the run that wrote it. Null when the reader may not see that run. */
  runId: string | null;
  text: string;
  threadId: string;
}

export interface ThreadView {
  discussion: { id: string; round: number; rounds: number } | null;
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

/**
 * A message that arrives from outside the app and lands in a team room, such as
 * one from the Slack channel linked to it. The room's rules still apply: the
 * post wakes agents only as `waker`.
 */
export interface ExternalPostInput {
  /**
   * Statements that join the post's atomic write. A key that conflicts there
   * (a message another delivery already recorded) rejects the whole write, so
   * no post and no topic are left behind.
   */
  alongside: (ids: { postId: string; threadId: string }) => Statement[];
  /** Who wrote it. Stored as a person, so the id must never be a Clerk user id the sender does not hold. */
  authorId: string;
  teamId: string;
  text: string;
  /** An existing topic of the team, or the title of a new one. */
  thread: { id: string; kind: "existing" } | { kind: "new"; title: string };
  /** Wakes agents as this person. Null wakes nobody. */
  waker: UserPrincipal | null;
  workspaceId: string;
}

export interface ExternalPostResult {
  postId: string;
  threadId: string;
  /** Wakes the agents the post names (or the listening lead). Call it after the answer to the sender. */
  wake: () => Promise<WokenRun[]>;
}

export interface NoticeResult {
  postId: string;
  runs: WokenRun[];
  threadId: string;
}

/** Why a wake did not happen, as `inbox.loop_stopped` records it. */
type StopReason = "budget" | "refused" | "streak";

type UserPrincipal = Extract<Principal, { kind: "user" }>;
type RunPrincipal = Extract<Principal, { kind: "run" }>;
type Member = UserPrincipal | RunPrincipal;
type ThreadRow = typeof inboxThreads.$inferSelect;
type PostRow = typeof inboxPosts.$inferSelect;

/** What a wake needs from the topic's team. */
interface Room {
  leadAgentId: string | null;
  leadListens: boolean;
  rules: string;
}

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
  teamId: row.teamId,
  title: row.title,
});

const storedFileIds = (row: PostRow): string[] =>
  z.array(z.string()).parse(JSON.parse(row.fileIds));

const toPost = (row: PostRow, links: PostLinks): PostRecord => ({
  artifacts: links.artifacts,
  authorId: row.authorId,
  authorKind: row.authorKind,
  createdAt: row.createdAt,
  fileIds: links.fileIds,
  id: row.id,
  runId: links.runId,
  text: row.text,
  threadId: row.threadId,
});

const roomerOf = (member: Member): Roomer =>
  member.kind === "user"
    ? { id: member.userId, kind: "user" }
    : { id: member.agentId, kind: "agent" };

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
  /** The digest of a team's room that an agent's wake input carries. Null, or a failure, means no digest. */
  roomDigest?: (teamId: string) => Promise<string | null>;
  /** Only `startRun` is used. The composition root passes it lazily, because the runs service is built with this service's gateway. */
  runs: Pick<RunsService, "startRun">;
}

export const createInboxService = ({
  atomic,
  clock,
  db,
  events,
  roomDigest,
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

  /**
   * The thread when `member` may use it. A limited topic the member is not in
   * answers not found, so its existence stays hidden. Posting also needs
   * membership in the topic's team.
   */
  const requireThread = async (
    member: Member,
    threadId: string,
    action: string,
    access: "post" | "read"
  ): Promise<ThreadRow> => {
    authorize(member, action, {
      id: threadId,
      kind: INBOX_KIND,
      workspaceId: member.workspaceId,
    });
    const thread = await findThread(threadId, member.workspaceId);
    const roomer = roomerOf(member);
    if (!(thread && (await canReadTopic(db, thread, roomer)))) {
      throw new ServiceError("not_found", "Thread not found");
    }
    if (access === "post" && !(await canPostInTopic(db, thread, roomer))) {
      throw new ForbiddenError(action);
    }
    return thread;
  };

  /** The post's run, files and artifacts as `member` may see them. */
  const linksFor = async (
    member: Member,
    threadId: string,
    rows: readonly PostRow[]
  ): Promise<Map<string, PostLinks>> => {
    if (rows.every((row) => row.runId === null)) {
      return new Map(
        rows.map((row) => [
          row.id,
          { artifacts: [], fileIds: storedFileIds(row), runId: null },
        ])
      );
    }
    return await postLinks(
      db,
      member,
      threadId,
      rows.map((row) => ({
        fileIds: storedFileIds(row),
        id: row.id,
        runId: row.runId,
      }))
    );
  };

  const toPostRecord = async (
    member: Member,
    thread: ThreadRow,
    row: PostRow
  ): Promise<PostRecord> => {
    const [record] = await toPosts(member, thread.id, [row]);
    if (!record) {
      throw new ServiceError("not_found", "Post not found");
    }
    return record;
  };

  const toPosts = async (
    member: Member,
    threadId: string,
    rows: readonly PostRow[]
  ): Promise<PostRecord[]> => {
    const links = await linksFor(member, threadId, rows);
    return rows.map((row) =>
      toPost(
        row,
        links.get(row.id) ?? { artifacts: [], fileIds: [], runId: null }
      )
    );
  };

  /**
   * The team the topic opens in, checked in the workspace, with the writer in
   * it. An agent opens a topic only in a team it leads (TM.4).
   */
  const teamForNewTopic = async (
    writer: Member,
    teamId: string | undefined
  ): Promise<string | null> => {
    if (writer.kind === "run" && teamId === undefined) {
      throw new ForbiddenError("inbox.create");
    }
    if (teamId === undefined) {
      // A new topic starts in the workspace's Everyone team until it names one.
      const [everyone] = await db
        .select({ id: teams.id })
        .from(teams)
        .where(
          and(
            eq(teams.workspaceId, writer.workspaceId),
            eq(teams.slug, EVERYONE_TEAM_SLUG)
          )
        );
      return everyone?.id ?? null;
    }
    const [team] = await db
      .select({
        archivedAt: teams.archivedAt,
        id: teams.id,
        leadAgentId: teams.leadAgentId,
      })
      .from(teams)
      .where(
        and(eq(teams.workspaceId, writer.workspaceId), eq(teams.id, teamId))
      );
    if (!team || team.archivedAt !== null) {
      throw new ServiceError("not_found", "Team not found");
    }
    if (writer.kind === "run" && team.leadAgentId !== writer.agentId) {
      throw new ForbiddenError("inbox.create");
    }
    if (!(await isInTeam(db, team.id, roomerOf(writer)))) {
      throw new ForbiddenError("inbox.create");
    }
    return team.id;
  };

  /** The topic's member subset: the writer plus the named members, each one in the team. */
  const limitedMembers = async (
    writer: Member,
    teamId: string | null,
    named: readonly Roomer[] | undefined
  ): Promise<Roomer[]> => {
    if (named === undefined || named.length === 0) {
      return [];
    }
    const all = new Map<string, Roomer>();
    for (const roomer of [roomerOf(writer), ...named]) {
      all.set(`${roomer.kind}:${roomer.id}`, roomer);
    }
    const agentIds = [...all.values()]
      .filter((roomer) => roomer.kind === "agent")
      .map((roomer) => roomer.id);
    if (agentIds.length > 0) {
      const found = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.workspaceId, writer.workspaceId),
            inArray(agents.id, agentIds)
          )
        );
      if (found.length !== agentIds.length) {
        throw new ServiceError("not_found", "Agent not found");
      }
    }
    for (const roomer of all.values()) {
      // biome-ignore lint/performance/noAwaitInLoops: at most MEMBERS_MAX short lookups
      if (!(await isInTeam(db, teamId, roomer))) {
        throw new ServiceError("invalid", "Every member must be in the team");
      }
    }
    return [...all.values()];
  };

  const createThread = async (
    principal: Principal,
    rawInput: ThreadCreateInput
  ): Promise<ThreadRecord> => {
    const input = threadCreateInputSchema.parse(rawInput);
    const writer = requireWriter(principal);
    authorize(writer, "inbox.create", {
      kind: INBOX_KIND,
      workspaceId: writer.workspaceId,
    });
    const created = clock.now().toISOString();
    const teamId = await teamForNewTopic(writer, input.teamId);
    const members = await limitedMembers(writer, teamId, input.members);
    const row: ThreadRow = {
      attentionClearedAt: null,
      attentionClearedBy: null,
      createdAt: created,
      // The agent's id stands in for a person when a lead opened the topic.
      createdBy: writer.kind === "user" ? writer.userId : writer.agentId,
      id: nextId(clock.now().getTime()),
      lastPostAt: created,
      openedByAgentId: writer.kind === "run" ? writer.agentId : null,
      teamId,
      title: input.title,
      workspaceId: writer.workspaceId,
    };
    await atomic([
      db.insert(inboxThreads).values(row),
      ...(members.length === 0
        ? []
        : [
            db.insert(inboxThreadMembers).values(
              members.map((roomer) => ({
                memberId: roomer.id,
                memberKind: roomer.kind,
                threadId: row.id,
                workspaceId: row.workspaceId,
              }))
            ),
          ]),
    ]);
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
      .where(
        and(
          eq(inboxThreads.workspaceId, member.workspaceId),
          topicVisibleTo(roomerOf(member))
        )
      )
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
    const thread = await requireThread(member, threadId, READ_ACTION, "read");
    const rows = await db
      .select()
      .from(inboxPosts)
      .where(eq(inboxPosts.threadId, thread.id))
      .orderBy(desc(inboxPosts.id))
      .limit(THREAD_READ_LIMIT);
    const discussion = await runningDiscussion(thread.id);
    return {
      discussion: discussion
        ? {
            id: discussion.id,
            round: discussion.round,
            rounds: discussion.rounds,
          }
        : null,
      posts: await toPosts(member, thread.id, rows.reverse()),
      thread: toThread(thread),
    };
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
    const thread = await requireThread(writer, threadId, POST_ACTION, "post");
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

  const postRow = (
    thread: ThreadRow,
    author: Author,
    body: { fileIds: readonly string[]; text: string },
    origin: PostOrigin | null
  ): PostRow => {
    const now = clock.now();
    return {
      authorId: author.id,
      authorKind: author.kind,
      createdAt: now.toISOString(),
      fileIds: JSON.stringify(body.fileIds),
      id: nextId(now.getTime()),
      runId: origin ? origin.runId : null,
      text: body.text,
      threadId: thread.id,
      workspaceId: thread.workspaceId,
    };
  };

  const announcePost = (
    thread: ThreadRow,
    row: PostRow,
    origin: PostOrigin | null
  ) =>
    events.append({
      actor: { id: row.authorId, kind: row.authorKind },
      agentId: row.authorKind === "agent" ? row.authorId : null,
      payload: { postId: row.id, threadId: thread.id },
      runId: origin ? origin.runId : null,
      sessionId: origin ? origin.sessionId : null,
      type: "inbox.posted",
      workspaceId: thread.workspaceId,
    });

  /** The post and the thread's `lastPostAt` in one atomic write, then `inbox.posted`. */
  const writePost = async (
    thread: ThreadRow,
    author: Author,
    body: { fileIds: readonly string[]; text: string },
    origin: PostOrigin | null
  ): Promise<PostRow> => {
    const row = postRow(thread, author, body, origin);
    const source = origin
      ? await loadRun(db, origin.runId, thread.workspaceId)
      : null;
    const once =
      source?.requestId?.startsWith("discussion:") === true &&
      source.reply.kind === "inbox" &&
      source.reply.threadId === thread.id;
    let inserted = true;
    await atomic(
      [
        once
          ? db
              .insert(inboxPosts)
              .select(
                db
                  .select({
                    authorId: sql<string>`${row.authorId}`.as("authorId"),
                    authorKind: sql<InboxAuthorKind>`${row.authorKind}`.as(
                      "authorKind"
                    ),
                    createdAt: sql<string>`${row.createdAt}`.as("createdAt"),
                    fileIds: sql<string>`${row.fileIds}`.as("fileIds"),
                    id: sql<string>`${row.id}`.as("id"),
                    runId: sql<string>`${row.runId}`.as("runId"),
                    text: sql<string>`${row.text}`.as("text"),
                    threadId: sql<string>`${row.threadId}`.as("threadId"),
                    workspaceId: sql<string>`${row.workspaceId}`.as(
                      "workspaceId"
                    ),
                  })
                  .from(sql`(select 1)`)
                  .where(
                    sql`not exists (select 1 from ${inboxPosts} where ${inboxPosts.runId} = ${row.runId} and ${inboxPosts.threadId} = ${thread.id})`
                  )
              )
              .returning()
          : db.insert(inboxPosts).values(row).returning(),
        db
          .update(inboxThreads)
          .set({ lastPostAt: row.createdAt })
          .where(eq(inboxThreads.id, thread.id)),
      ],
      (results) => {
        inserted = (results[0] as PostRow[]).length > 0;
      }
    );
    if (!inserted && origin) {
      const [existing] = await db
        .select()
        .from(inboxPosts)
        .where(
          and(
            eq(inboxPosts.runId, origin.runId),
            eq(inboxPosts.threadId, thread.id)
          )
        )
        .limit(1);
      if (existing) {
        return existing;
      }
    }
    await announcePost(thread, row, origin);
    return row;
  };

  /** The active agents the post names, in mention order. An agent does not wake itself. */
  const mentionedAgents = async (entry: PostRow, workspaceId: string) => {
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
    workspaceId: string,
    discussion = false
  ): Promise<boolean> => {
    const now = clock.now().getTime();
    // The run table is the ledger. Discussions share Q&A's cross-surface
    // hourly window; ordinary inbox wakes keep their existing guard.
    const woken = await db
      .select({ createdAt: runRows.createdAt })
      .from(runRows)
      .innerJoin(sessions, eq(runRows.sessionId, sessions.id))
      .where(
        and(
          eq(runRows.workspaceId, workspaceId),
          eq(runRows.agentId, agentId),
          discussion
            ? inArray(sessions.origin, ["inbox", "qa"])
            : eq(sessions.origin, "inbox"),
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

  /**
   * Catch-up for `agentId`: every post before `entry` since the agent last
   * posted in this topic, oldest first. The wake input's character budget drops
   * the oldest of them. The read is bounded, newest first.
   */
  const earlierPosts = async (
    thread: ThreadRow,
    entry: PostRow,
    agentId: string
  ) => {
    const [own] = await db
      .select({ id: inboxPosts.id })
      .from(inboxPosts)
      .where(
        and(
          eq(inboxPosts.threadId, thread.id),
          eq(inboxPosts.authorKind, "agent"),
          eq(inboxPosts.authorId, agentId),
          lt(inboxPosts.id, entry.id)
        )
      )
      .orderBy(desc(inboxPosts.id))
      .limit(1);
    const rows = await db
      .select({
        authorId: inboxPosts.authorId,
        authorKind: inboxPosts.authorKind,
        text: inboxPosts.text,
      })
      .from(inboxPosts)
      .where(
        and(
          eq(inboxPosts.threadId, thread.id),
          lt(inboxPosts.id, entry.id),
          own ? gt(inboxPosts.id, own.id) : undefined
        )
      )
      .orderBy(desc(inboxPosts.id))
      .limit(WAKE_CATCH_UP_READ_LIMIT);
    return rows.reverse();
  };

  const recordStop = (
    waker: Member,
    thread: ThreadRow,
    entry: PostRow,
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

  /** The thread's team: its rules, its lead and whether the lead listens. */
  const roomOf = async (thread: ThreadRow): Promise<Room> => {
    if (thread.teamId === null) {
      return { leadAgentId: null, leadListens: false, rules: "" };
    }
    const [team] = await db
      .select({
        archivedAt: teams.archivedAt,
        leadAgentId: teams.leadAgentId,
        leadListens: teams.leadListens,
        rules: teams.rules,
      })
      .from(teams)
      .where(
        and(
          eq(teams.id, thread.teamId),
          eq(teams.workspaceId, thread.workspaceId)
        )
      );
    if (!team) {
      return { leadAgentId: null, leadListens: false, rules: "" };
    }
    return {
      leadAgentId: team.archivedAt === null ? team.leadAgentId : null,
      leadListens: team.leadListens,
      rules: team.rules,
    };
  };

  /**
   * The lead that hears a person's post naming no agent: the team's lead when
   * the team listens, the lead is active, and the lead may post in the topic
   * (a limited topic without the lead stays unheard).
   */
  const listeningLead = async (
    thread: ThreadRow,
    room: Room
  ): Promise<{ id: string } | null> => {
    if (!(room.leadListens && room.leadAgentId)) {
      return null;
    }
    const [lead] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, room.leadAgentId),
          eq(agents.workspaceId, thread.workspaceId),
          eq(agents.status, "active")
        )
      );
    if (!lead) {
      return null;
    }
    const reachable = await canPostInTopic(db, thread, {
      id: lead.id,
      kind: "agent",
    });
    return reachable ? lead : null;
  };

  /** The team room's digest for the thread, or null. A failing digest never stops a wake. */
  const digestFor = async (thread: ThreadRow): Promise<string | null> => {
    if (thread.teamId === null || roomDigest === undefined) {
      return null;
    }
    try {
      return await roomDigest(thread.teamId);
    } catch {
      return null;
    }
  };

  /** One mentioned agent: the guard first, then the run. Null when the wake was stopped. */
  const wakeOne = async (
    waker: Member,
    thread: ThreadRow,
    entry: PostRow,
    target: { id: string },
    room: Room,
    streak: boolean,
    requestId?: string
  ): Promise<WokenRun | null> => {
    let stop: StopReason | null = null;
    if (streak) {
      stop = "streak";
    } else if (
      await budgetSpent(target.id, thread.workspaceId, requestId !== undefined)
    ) {
      stop = "budget";
    }
    if (stop) {
      await recordStop(waker, thread, entry, target.id, stop);
      return null;
    }
    const digest = await digestFor(thread);
    try {
      // Discussion wakes are independent room runs. Persisted retry keys bound
      // them without growing an ancestry chain across rounds.
      const result = await runs.startRun(requestId ? SYSTEM_PRINCIPAL : waker, {
        ...(requestId ? { requestId } : {}),
        agentId: target.id,
        input: {
          text: buildWakeInput({
            digest,
            earlier: await earlierPosts(thread, entry, target.id),
            rules: room.rules,
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
    entry: PostRow
  ): Promise<WokenRun[]> => {
    const discussion = await runningDiscussion(thread.id);
    if (discussion) {
      await driveDiscussion(discussion);
      // A person's post still wakes whoever it mentions, as it does outside a
      // discussion. Agent posts only drive the rounds, so they cannot chain.
      if (entry.authorKind === "agent") {
        return [];
      }
    }
    const room = await roomOf(thread);
    const mentioned = await mentionedAgents(entry, thread.workspaceId);
    const listening =
      mentioned.length === 0 && entry.authorKind === "user"
        ? await listeningLead(thread, room)
        : null;
    const targets = listening ? [listening] : mentioned;
    if (targets.length === 0) {
      return [];
    }
    const streak = await streakReached(thread.id);
    const started: WokenRun[] = [];
    for (const target of targets) {
      // biome-ignore lint/performance/noAwaitInLoops: a wake can post and wake again, so they stay in order
      const unreachable = !(await canPostInTopic(db, thread, {
        id: target.id,
        kind: "agent",
      }));
      if (unreachable) {
        await recordStop(
          waker,
          thread,
          entry,
          target.id,
          "refused",
          "The agent is not in this room or topic"
        );
        continue;
      }
      const woken = await wakeOne(waker, thread, entry, target, room, streak);
      if (woken) {
        started.push(woken);
      }
    }
    return started;
  };

  /**
   * The team's topic with exactly `title` that has no member rows, the oldest
   * one. A limited topic never counts. Opens the topic when there is none.
   */
  const noticeTopic = async (
    team: { id: string; workspaceId: string },
    title: string,
    authorAgentId: string | null
  ): Promise<ThreadRow> => {
    const [existing] = await db
      .select()
      .from(inboxThreads)
      .where(
        and(
          eq(inboxThreads.workspaceId, team.workspaceId),
          eq(inboxThreads.teamId, team.id),
          eq(inboxThreads.title, title),
          notExists(
            db
              .select({ threadId: inboxThreadMembers.threadId })
              .from(inboxThreadMembers)
              .where(eq(inboxThreadMembers.threadId, inboxThreads.id))
          )
        )
      )
      // Ids sort in creation order, so the first one is the oldest.
      .orderBy(asc(inboxThreads.id))
      .limit(1);
    if (existing) {
      return existing;
    }
    const created = clock.now().toISOString();
    const row: ThreadRow = {
      attentionClearedAt: null,
      attentionClearedBy: null,
      createdAt: created,
      createdBy: "system",
      id: nextId(clock.now().getTime()),
      lastPostAt: created,
      openedByAgentId: authorAgentId,
      teamId: team.id,
      title,
      workspaceId: team.workspaceId,
    };
    await atomic([db.insert(inboxThreads).values(row)]);
    return row;
  };

  /**
   * The notice's one wake: the named agent, when it is active in the workspace
   * and may post in the topic. Otherwise nothing is recorded and nothing starts.
   */
  const wakeNoticeAgent = async (
    thread: ThreadRow,
    entry: PostRow,
    wakeTarget: { agentId: string; asUserId: string }
  ): Promise<WokenRun[]> => {
    const [agent] = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.id, wakeTarget.agentId),
          eq(agents.workspaceId, thread.workspaceId),
          eq(agents.status, "active")
        )
      );
    if (!agent) {
      return [];
    }
    const mayPost = await canPostInTopic(db, thread, {
      id: agent.id,
      kind: "agent",
    });
    if (!mayPost) {
      return [];
    }
    const waker: UserPrincipal = {
      kind: "user",
      userId: wakeTarget.asUserId,
      via: "session",
      workspaceId: thread.workspaceId,
    };
    const woken = await wakeOne(
      waker,
      thread,
      entry,
      { id: agent.id },
      await roomOf(thread),
      false
    );
    return woken ? [woken] : [];
  };

  /**
   * The system posts a notice into a team room, in the topic with its title
   * (opened on first use). The author is the agent given, or "system". A
   * notice never wakes agents from the mentions in its text. Only `wake` does,
   * and it wakes one agent.
   */
  const postNotice = async (
    principal: Principal,
    rawInput: NoticeInput
  ): Promise<NoticeResult> => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(NOTICE_ACTION);
    }
    const input = noticeInputSchema.parse(rawInput);
    const [team] = await db
      .select({
        archivedAt: teams.archivedAt,
        id: teams.id,
        workspaceId: teams.workspaceId,
      })
      .from(teams)
      .where(eq(teams.id, input.teamId));
    if (!team || team.archivedAt !== null) {
      throw new ServiceError("not_found", `No team ${input.teamId}`);
    }
    const thread = await noticeTopic(team, input.title, input.authorAgentId);
    const author: Author =
      input.authorAgentId === null
        ? { id: SYSTEM_AUTHOR_ID, kind: "user" }
        : { id: input.authorAgentId, kind: "agent" };
    const written = await writePost(
      thread,
      author,
      { fileIds: [], text: input.text },
      null
    );
    const woken = input.wake
      ? await wakeNoticeAgent(thread, written, input.wake)
      : [];
    return { postId: written.id, runs: woken, threadId: thread.id };
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
    const thread = await requireThread(
      writer,
      input.threadId,
      POST_ACTION,
      "post"
    );
    if (writer.kind === "user") {
      const written = await writePost(
        thread,
        { id: writer.userId, kind: "user" },
        { fileIds: [], text: input.text },
        null
      );
      return {
        post: await toPostRecord(writer, thread, written),
        runs: await wake(writer, thread, written),
      };
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
    return {
      post: await toPostRecord(writer, thread, written),
      runs: await wake(writer, thread, written),
    };
  };

  /**
   * Records a message from outside in a team room: in an existing topic of the
   * team, or in a new one the message opens. Nothing is checked about the
   * author, the caller has decided who they are and whether they may wake agents.
   */
  const postExternal = async (
    input: ExternalPostInput
  ): Promise<ExternalPostResult> => {
    const created = clock.now().toISOString();
    const statements: Statement[] = [];
    let thread: ThreadRow;
    if (input.thread.kind === "new") {
      thread = {
        attentionClearedAt: null,
        attentionClearedBy: null,
        createdAt: created,
        createdBy: input.authorId,
        id: nextId(clock.now().getTime()),
        lastPostAt: created,
        openedByAgentId: null,
        teamId: input.teamId,
        title: input.thread.title.slice(0, TITLE_MAX),
        workspaceId: input.workspaceId,
      };
      statements.push(db.insert(inboxThreads).values(thread));
    } else {
      const found = await findThread(input.thread.id, input.workspaceId);
      if (found?.teamId !== input.teamId) {
        throw new ServiceError("not_found", "Thread not found");
      }
      thread = found;
    }
    const row = postRow(
      thread,
      { id: input.authorId, kind: "user" },
      { fileIds: [], text: input.text },
      null
    );
    statements.push(
      db.insert(inboxPosts).values(row),
      db
        .update(inboxThreads)
        .set({ lastPostAt: row.createdAt })
        .where(eq(inboxThreads.id, thread.id)),
      ...input.alongside({ postId: row.id, threadId: thread.id })
    );
    await atomic(statements);
    await announcePost(thread, row, null);
    const { waker } = input;
    const opened = thread;
    return {
      postId: row.id,
      threadId: opened.id,
      wake: async () => (waker ? await wake(waker, opened, row) : []),
    };
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

  const {
    runningDiscussion,
    driveDiscussion,
    startDiscussion,
    stopDiscussion,
    sweepDiscussions,
  } = createDiscussionRounds({
    announcePost,
    atomic,
    clock,
    db,
    findThread,
    postRow,
    requireThread,
    requireWriter,
    roomOf,
    wakeOne,
  });

  const gateway: Gateway = { deliver, kind: "inbox" };

  return {
    clearAttention,
    createThread,
    gateway,
    listThreads,
    post,
    postExternal,
    postNotice,
    readThread,
    startDiscussion,
    stopDiscussion,
    sweepDiscussions,
  };
};

export type InboxService = ReturnType<typeof createInboxService>;
