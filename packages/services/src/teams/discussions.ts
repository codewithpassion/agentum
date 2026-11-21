/** Durable discussion rounds over the existing discussions, posts and run retry keys. */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agents } from "@repo/db/schema/agents";
import { discussions } from "@repo/db/schema/discussions";
import { inboxPosts, inboxThreads } from "@repo/db/schema/inbox";
import { runs as runRows } from "@repo/db/schema/runs";
import { teamMembers } from "@repo/db/schema/teams";
import { DISCUSSION_ROUNDS_MAX, LIVE_RUN_STATUSES } from "@repo/db/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { ForbiddenError } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { discussionBudgetAllows } from "../inbox/loop-guard.ts";
import { canPostInTopic, canReadTopic } from "../inbox/room-access.ts";
import { loadRun } from "../runs/queries.ts";
import type { Clock } from "../runs/types.ts";
import { idString } from "../shared.ts";
import type { Principal } from "../workspaces.ts";
import { leadRoomOf } from "./room-run.ts";

type ThreadRow = typeof inboxThreads.$inferSelect;
type PostRow = typeof inboxPosts.$inferSelect;
type UserPrincipal = Extract<Principal, { kind: "user" }>;
type Member = Extract<Principal, { kind: "user" | "run" }>;
interface Room {
  leadAgentId: string | null;
  leadListens: boolean;
  rules: string;
}
interface PostOrigin {
  runId: string;
  sessionId: string;
}
const POST_ACTION = "inbox.post";
/**
 * Members get this long to answer a round. A lead that has not replied by
 * twice this, measured from the round's opening, ends the discussion.
 */
const ROUND_WINDOW_MS = 10 * 60 * 1000;

export const discussionInputSchema = z.strictObject({
  question: z.string().trim().min(1).max(80_000),
  rounds: z.number().int().min(1).max(DISCUSSION_ROUNDS_MAX),
  topic: idString,
});

interface DiscussionDeps {
  announcePost: (
    thread: ThreadRow,
    row: PostRow,
    origin: PostOrigin | null
  ) => Promise<unknown>;
  atomic: Atomic;
  clock: Clock;
  db: Database;
  findThread: (
    id: string,
    workspaceId: string
  ) => Promise<ThreadRow | null | undefined>;
  postRow: (
    thread: ThreadRow,
    author: { id: string; kind: "agent" | "user" },
    body: { fileIds: readonly string[]; text: string },
    origin: PostOrigin | null
  ) => PostRow;
  requireThread: (
    member: Member,
    id: string,
    action: string,
    access: "post" | "tend"
  ) => Promise<ThreadRow>;
  requireWriter: (principal: Principal) => Member;
  roomOf: (thread: ThreadRow) => Promise<Room>;
  wakeOne: (
    waker: Member,
    thread: ThreadRow,
    entry: PostRow,
    target: { id: string },
    room: Room,
    streak: boolean,
    requestId?: string
  ) => Promise<unknown>;
}

export const createDiscussionRounds = ({
  db,
  atomic,
  clock,
  findThread,
  requireThread,
  requireWriter,
  roomOf,
  postRow,
  announcePost,
  wakeOne,
}: DiscussionDeps) => {
  const runningDiscussion = async (threadId: string) => {
    const [row] = await db
      .select()
      .from(discussions)
      .where(
        and(
          eq(discussions.threadId, threadId),
          eq(discussions.status, "running")
        )
      )
      .limit(1);
    return row ?? null;
  };

  const discussionKey = (id: string, round: number, agentId: string) =>
    `discussion:${id}:${round}:${agentId}`;

  const discussionOpening = async (
    discussion: typeof discussions.$inferSelect,
    question: PostRow
  ) => {
    const [previous] =
      discussion.round > 1
        ? await db
            .select()
            .from(runRows)
            .where(
              eq(
                runRows.requestId,
                discussionKey(
                  discussion.id,
                  discussion.round - 1,
                  discussion.startedByAgentId
                )
              )
            )
        : [];
    const [opening] = previous
      ? await db
          .select()
          .from(inboxPosts)
          .where(
            and(
              eq(inboxPosts.runId, previous.id),
              eq(inboxPosts.threadId, discussion.threadId)
            )
          )
          .orderBy(inboxPosts.id)
          .limit(1)
      : [question];
    return opening;
  };

  /** Closes a discussion whose lead never answered. Only a running one changes. */
  const endDiscussion = async (discussion: typeof discussions.$inferSelect) => {
    await db
      .update(discussions)
      .set({ status: "done" })
      .where(
        and(
          eq(discussions.id, discussion.id),
          eq(discussions.status, "running"),
          eq(discussions.round, discussion.round)
        )
      );
  };

  /** True when the lead's reply was there and the round moved on or closed. */
  const advanceDiscussion = async (
    discussion: typeof discussions.$inferSelect,
    checkpointId: string
  ): Promise<boolean> => {
    const [reply] = await db
      .select()
      .from(inboxPosts)
      .where(
        and(
          eq(inboxPosts.runId, checkpointId),
          eq(inboxPosts.threadId, discussion.threadId)
        )
      )
      .limit(1);
    if (reply) {
      const close =
        discussion.round === discussion.rounds ||
        reply.text.startsWith("/close");
      const changed = await db
        .update(discussions)
        .set(close ? { status: "done" } : { round: discussion.round + 1 })
        .where(
          and(
            eq(discussions.id, discussion.id),
            eq(discussions.status, "running"),
            eq(discussions.round, discussion.round)
          )
        )
        .returning();
      if (changed[0]?.status === "running") {
        await driveDiscussion(changed[0]);
      }
    }
    return Boolean(reply);
  };

  const wakeDiscussionMember = async (
    {
      discussion,
      thread,
      opening,
      room,
      waker,
      timedOut,
      memberCount,
      wakes,
    }: {
      discussion: typeof discussions.$inferSelect;
      thread: ThreadRow;
      opening: PostRow;
      room: Room;
      waker: UserPrincipal;
      timedOut: boolean;
      memberCount: number;
      wakes: number;
    },
    target: { id: string }
  ) => {
    const key = discussionKey(discussion.id, discussion.round, target.id);
    let [run] = await db
      .select()
      .from(runRows)
      .where(
        and(
          eq(runRows.workspaceId, thread.workspaceId),
          eq(runRows.requestId, key)
        )
      );
    if (
      !(run || timedOut) &&
      discussionBudgetAllows(
        discussion.round,
        discussion.rounds,
        memberCount,
        wakes
      ) &&
      (await canPostInTopic(db, thread, { id: target.id, kind: "agent" }))
    ) {
      // Re-read after every wake: stop and round advancement can race dispatch.
      const live = await runningDiscussion(thread.id);
      if (live?.id !== discussion.id || live.round !== discussion.round) {
        return false;
      }
      await wakeOne(waker, thread, opening, target, room, false, key);
      [run] = await db
        .select()
        .from(runRows)
        .where(
          and(
            eq(runRows.workspaceId, thread.workspaceId),
            eq(runRows.requestId, key)
          )
        );
    }
    const [posted] = run
      ? await db
          .select({ id: inboxPosts.id })
          .from(inboxPosts)
          .where(
            and(
              eq(inboxPosts.runId, run.id),
              eq(inboxPosts.threadId, discussion.threadId)
            )
          )
          .limit(1)
      : [];
    return Boolean(posted);
  };

  /**
   * The posted question's final Participants line snapshots the agents by id in ordinary profile links.
   * People and the coordinating lead are not member wakes. Keep that line on
   * the question (not later replies), so mentions cannot widen the budget.
   * Each round is opened by the checkpoint lead's first post; a final reply
   * closes it. A checkpoint reply starting with /close closes early.
   */
  const discussionContext = async (
    discussion: typeof discussions.$inferSelect
  ) => {
    const current = await runningDiscussion(discussion.threadId);
    if (current?.id !== discussion.id || current.round !== discussion.round) {
      return null;
    }
    const thread = await findThread(
      discussion.threadId,
      discussion.workspaceId
    );
    if (!thread) {
      return null;
    }
    const [question] = await db
      .select()
      .from(inboxPosts)
      .where(eq(inboxPosts.id, discussion.id));
    if (!question) {
      return null;
    }
    const memberIds = [
      ...(question.text.split("\n\nParticipants: ").at(-1) ?? "").matchAll(
        /\]\(\/agents\/([A-Za-z0-9_-]+)\)/g
      ),
    ].map((match) => match[1] as string);
    const room = await roomOf(thread);
    const waker: UserPrincipal = {
      kind: "user",
      userId: thread.createdBy,
      via: "session",
      workspaceId: thread.workspaceId,
    };
    const opening = await discussionOpening(discussion, question);
    if (!opening) {
      return null;
    }
    const timedOut =
      clock.now().getTime() - Date.parse(opening.createdAt) >= ROUND_WINDOW_MS;
    // A lead that never replies to its checkpoint would hold the discussion
    // open for good, so the round ends for everyone after a second window.
    const expired =
      clock.now().getTime() - Date.parse(opening.createdAt) >=
      2 * ROUND_WINDOW_MS;
    const participants = memberIds.length
      ? await db
          .select({ id: agents.id })
          .from(agents)
          .where(
            and(
              eq(agents.workspaceId, thread.workspaceId),
              inArray(agents.id, memberIds)
            )
          )
      : [];
    return {
      expired,
      memberIds,
      opening,
      participants,
      question,
      room,
      thread,
      timedOut,
      waker,
    };
  };

  const driveDiscussion = async (
    discussion: typeof discussions.$inferSelect
  ): Promise<void> => {
    const context = await discussionContext(discussion);
    if (!context) {
      return;
    }
    const {
      thread,
      opening,
      memberIds,
      room,
      waker,
      timedOut,
      expired,
      participants,
    } = context;
    const checkpointKey = discussionKey(
      discussion.id,
      discussion.round,
      discussion.startedByAgentId
    );
    const [checkpoint] = await db
      .select()
      .from(runRows)
      .where(
        and(
          eq(runRows.workspaceId, thread.workspaceId),
          eq(runRows.requestId, checkpointKey)
        )
      );
    if (checkpoint) {
      const advanced = await advanceDiscussion(discussion, checkpoint.id);
      // A checkpoint run that is still queued, running or waiting may yet
      // reply, so only one that has ended without posting expires.
      const live = LIVE_RUN_STATUSES.includes(checkpoint.status);
      if (!advanced && expired && !live) {
        await endDiscussion(discussion);
      }
      return;
    }
    if (expired) {
      await endDiscussion(discussion);
      return;
    }
    const ledger = await db
      .select({ id: runRows.id })
      .from(runRows)
      .where(
        and(
          eq(runRows.workspaceId, thread.workspaceId),
          sql`${runRows.requestId} like ${`discussion:${discussion.id}:%`}`,
          sql`${runRows.agentId} <> ${discussion.startedByAgentId}`
        )
      );
    let allPosted = true;
    for (const target of participants) {
      if (
        // biome-ignore lint/performance/noAwaitInLoops: dispatch can synchronously advance the round
        !(await wakeDiscussionMember(
          {
            discussion,
            memberCount: memberIds.length,
            opening,
            room,
            thread,
            timedOut,
            waker,
            wakes: ledger.length,
          },
          target
        ))
      ) {
        allPosted = false;
      }
    }
    if (!(allPosted || timedOut)) {
      return;
    }
    await wakeDiscussionLead(context, discussion, checkpointKey);
  };

  const wakeDiscussionLead = async (
    {
      thread,
      opening,
      room,
      waker,
    }: NonNullable<Awaited<ReturnType<typeof discussionContext>>>,
    discussion: typeof discussions.$inferSelect,
    checkpointKey: string
  ) => {
    if (
      !(await canPostInTopic(db, thread, {
        id: discussion.startedByAgentId,
        kind: "agent",
      }))
    ) {
      return;
    }
    const live = await runningDiscussion(thread.id);
    if (live?.id !== discussion.id || live.round !== discussion.round) {
      return;
    }
    // The checkpoint catches up through the newest reply, not the round's
    // opening post, so the lead sees the answers it is being asked to review.
    const [latest] = await db
      .select()
      .from(inboxPosts)
      .where(eq(inboxPosts.threadId, thread.id))
      .orderBy(desc(inboxPosts.id))
      .limit(1);
    if (!latest) {
      return;
    }
    await wakeOne(
      waker,
      thread,
      {
        ...latest,
        text: `Discussion round ${discussion.round}/${discussion.rounds} ended. Review the replies. Post once with team_post (start with /close to close early) to ${discussion.round === discussion.rounds ? "close the discussion" : "open the next round with your next question"}.\n${opening.text}\nLatest post:\n${latest.text}`,
      },
      { id: discussion.startedByAgentId },
      room,
      false,
      checkpointKey
    );
  };

  const startDiscussion = async (
    principal: Principal,
    raw: z.input<typeof discussionInputSchema>
  ) => {
    const input = discussionInputSchema.parse(raw);
    const writer = requireWriter(principal);
    if (writer.kind !== "run") {
      throw new ForbiddenError(POST_ACTION);
    }
    const run = await loadRun(db, writer.runId, writer.workspaceId);
    const room = run ? await leadRoomOf(db, run) : null;
    const thread = await requireThread(
      writer,
      input.topic,
      POST_ACTION,
      "post"
    );
    if (
      !(run && room) ||
      run.agentId !== writer.agentId ||
      room.teamId !== thread.teamId
    ) {
      throw new ForbiddenError(POST_ACTION);
    }
    if (await runningDiscussion(thread.id)) {
      throw new ServiceError("conflict", "A discussion is already running");
    }
    const members = await db
      .select({ id: agents.id, slug: agents.slug })
      .from(teamMembers)
      .innerJoin(agents, eq(agents.id, teamMembers.memberId))
      .where(
        and(
          eq(teamMembers.teamId, room.teamId),
          eq(teamMembers.memberKind, "agent"),
          eq(agents.status, "active"),
          eq(agents.workspaceId, writer.workspaceId)
        )
      );
    const participants = (
      await Promise.all(
        members.map(async (member) =>
          member.id !== writer.agentId &&
          (await canReadTopic(db, thread, { id: member.id, kind: "agent" }))
            ? member
            : null
        )
      )
    ).filter((member) => member !== null);
    if (!participants.length) {
      throw new ServiceError("invalid", "The topic has no other agent members");
    }
    const entry = postRow(
      thread,
      { id: writer.agentId, kind: "agent" },
      {
        fileIds: [],
        text: `${input.question}\n\nParticipants: ${participants.map((member) => `[@${member.slug}](/agents/${member.id})`).join(" ")}`,
      },
      { runId: writer.runId, sessionId: run.sessionId }
    );
    const row = {
      createdAt: entry.createdAt,
      id: entry.id,
      round: 1,
      rounds: input.rounds,
      startedByAgentId: writer.agentId,
      status: "running" as const,
      threadId: thread.id,
      workspaceId: writer.workspaceId,
    };
    // The INSERT SELECT serializes concurrent starts without changing TX.1's schema.
    await atomic([
      db.insert(discussions).select(
        db
          .select({
            createdAt: sql<string>`${row.createdAt}`.as("createdAt"),
            id: sql<string>`${row.id}`.as("id"),
            round: sql<number>`1`.as("round"),
            rounds: sql<number>`${row.rounds}`.as("rounds"),
            startedByAgentId: sql<string>`${row.startedByAgentId}`.as(
              "startedByAgentId"
            ),
            status: sql`'running'`.as("status"),
            threadId: sql<string>`${row.threadId}`.as("threadId"),
            workspaceId: sql<string>`${row.workspaceId}`.as("workspaceId"),
          })
          .from(sql`(select 1)`)
          .where(
            sql`not exists (select 1 from ${discussions} where ${discussions.threadId} = ${thread.id} and ${discussions.status} = 'running')`
          )
      ),
      db.insert(inboxPosts).select(
        db
          .select({
            authorId: sql<string>`${entry.authorId}`.as("authorId"),
            authorKind: sql`'agent'`.as("authorKind"),
            createdAt: sql<string>`${entry.createdAt}`.as("createdAt"),
            fileIds: sql<string>`'[]'`.as("fileIds"),
            guestName: sql<string | null>`null`.as("guestName"),
            id: sql<string>`${entry.id}`.as("id"),
            runId: sql<string>`${entry.runId}`.as("runId"),
            text: sql<string>`${entry.text}`.as("text"),
            threadId: sql<string>`${entry.threadId}`.as("threadId"),
            workspaceId: sql<string>`${entry.workspaceId}`.as("workspaceId"),
          })
          .from(sql`(select 1)`)
          .where(
            sql`exists (select 1 from ${discussions} where ${discussions.id} = ${row.id})`
          )
      ),
      db
        .update(inboxThreads)
        .set({ lastPostAt: entry.createdAt })
        .where(
          and(
            eq(inboxThreads.id, thread.id),
            sql`exists (select 1 from ${discussions} where ${discussions.id} = ${row.id})`
          )
        ),
    ]);
    const live = await runningDiscussion(thread.id);
    if (live?.id !== row.id) {
      throw new ServiceError("conflict", "A discussion is already running");
    }
    await announcePost(thread, entry, {
      runId: writer.runId,
      sessionId: run.sessionId,
    });
    await driveDiscussion(row);
    return { id: row.id, round: row.round, rounds: row.rounds };
  };

  const stopDiscussion = async (
    principal: Principal,
    input: { threadId: string }
  ) => {
    const writer = requireWriter(principal);
    if (writer.kind !== "user" || writer.via !== "session") {
      throw new ForbiddenError(POST_ACTION);
    }
    const thread = await requireThread(
      writer,
      input.threadId,
      POST_ACTION,
      "tend"
    );
    await db
      .update(discussions)
      .set({ status: "stopped" })
      .where(
        and(
          eq(discussions.threadId, thread.id),
          eq(discussions.status, "running")
        )
      );
  };

  const sweepDiscussions = async (principal: Principal) => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(POST_ACTION);
    }
    const rows = await db
      .select()
      .from(discussions)
      .where(eq(discussions.status, "running"));
    for (const row of rows) {
      // biome-ignore lint/performance/noAwaitInLoops: a wake can finish inside dispatch
      await driveDiscussion(row);
    }
  };

  return {
    driveDiscussion,
    runningDiscussion,
    startDiscussion,
    stopDiscussion,
    sweepDiscussions,
  };
};
