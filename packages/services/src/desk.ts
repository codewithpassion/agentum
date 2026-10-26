/**
 * The desk home: three lanes over runs, inbox threads and pending approvals,
 * and the Needs you count for the sidebar badge. One call computes them so the
 * page and the badge read the same things.
 *
 * Needs you holds what waits on a person: open approvals and questions,
 * proposed skill versions, triggers and routines, and inbox threads an agent
 * answered last. Running holds the live runs, and Done today the runs that
 * finished since the viewer's midnight. Every lane follows the sessions rules,
 * so another member's ui session or private Slack DM never shows.
 */
import type { Database } from "@repo/db";
import { agents as agentRows } from "@repo/db/schema/agents";
import { inboxPosts } from "@repo/db/schema/inbox";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { skills } from "@repo/db/schema/skills";
import { triggers as triggerRows } from "@repo/db/schema/triggers";
import {
  type DeskCard,
  isPendingProposal,
  type RunStatus,
} from "@repo/db/shared";
import { and, count, desc, eq, gte, inArray, max, ne } from "drizzle-orm";
import { z } from "zod";
import { authorize, ForbiddenError } from "./authz.ts";
import { personLabel } from "./events/summary.ts";
import type { PeopleLookup } from "./events.ts";
import type { InboxService } from "./inbox.ts";
import type { RequestRecord, RequestsService } from "./requests.ts";
import type { RoutinesService } from "./routines.ts";
import type { Clock } from "./runs/types.ts";
import { visibleSessions } from "./sessions.ts";
import type { SkillsStoreService } from "./skills-store.ts";
import { text } from "./tasks/format.ts";
import { inBatches, latestBandEvents } from "./tasks/reads.ts";
import { statusBand } from "./tasks/status-band.ts";
import type { TriggersService } from "./triggers.ts";
import type { Principal } from "./workspaces.ts";

/** Longest `detail` an item carries. */
const DETAIL_MAX = 2000;

/** Longest title a run card carries. */
const TITLE_MAX = 120;

/** Most cards in Done today. The rest are a count. */
const DONE_CAP = 20;

const READ_ACTION = "desk.read";
const DESK_KIND = "desk";

const LIVE_STATUSES: readonly RunStatus[] = [
  "queued",
  "offered",
  "running",
  "waiting",
];
const FINISHED_STATUSES: readonly RunStatus[] = [
  "done",
  "failed",
  "cancelled",
  "interrupted",
];

export const deskInputSchema = z.strictObject({
  agentId: z.string().min(1).max(200).optional(),
  /** The viewer's local midnight, as an ISO time. */
  dayStart: z.iso.datetime(),
});
export type DeskInput = z.input<typeof deskInputSchema>;

/** The desk as the page shows it. */
export interface DeskView {
  /** Finished runs since `dayStart`, newest first, at most 20. */
  done: DeskCard[];
  /** How many more finished runs there are than `done` holds. */
  doneMore: number;
  needsYou: DeskCard[];
  running: DeskCard[];
}

type UserPrincipal = Extract<Principal, { kind: "user" }>;

/** One thing waiting on the member, as C4 lists it. */
export interface NeedsYouItem {
  agent: string;
  createdAt: string;
  detail: string;
  expiresAt: string;
  kind: "approval" | "question";
  requestId: string;
  runId: string;
  title: string;
}

const clip = (value: string, limit: number = DETAIL_MAX): string =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/** Title and detail from the stored, already scrubbed display. */
const describe = (record: RequestRecord): { detail: string; title: string } => {
  const { display } = record;
  if ("questions" in display) {
    const [first] = display.questions;
    return {
      detail: clip(
        display.questions
          .map(({ choices, question }) =>
            choices?.length ? `${question} (${choices.join(" / ")})` : question
          )
          .join("\n")
      ),
      title: clip(first?.header ?? first?.question ?? "Question"),
    };
  }
  return {
    detail: clip(
      typeof display.input === "string"
        ? display.input
        : JSON.stringify(display.input, null, 2)
    ),
    title: display.summary,
  };
};

/** Who or what started something, before the name is looked up. */
interface Starter {
  id: string;
  kind: string;
}

/** A card before its `startedBy` is named. */
type Draft = Omit<DeskCard, "startedBy"> & { starter: Starter };

const byAge = (a: DeskCard, b: DeskCard): number =>
  a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at);

/** The first line of what was asked, as a card title. */
const titleOf = (inputText: string): string => {
  const [line] = text(inputText).split("\n");
  return clip(line?.trim() || "Task", TITLE_MAX);
};

export const createDeskService = ({
  clock,
  db,
  inbox,
  people,
  requests,
  routines,
  skillsStore,
  triggers,
}: {
  clock: Clock;
  db: Database;
  inbox: Pick<InboxService, "listThreads">;
  people?: PeopleLookup;
  requests: Pick<RequestsService, "listPending">;
  routines: Pick<RoutinesService, "list">;
  skillsStore: Pick<SkillsStoreService, "proposals">;
  triggers: Pick<TriggersService, "list">;
}) => {
  const requireMember = (principal: Principal): UserPrincipal => {
    if (principal.kind !== "user") {
      throw new ForbiddenError(READ_ACTION);
    }
    authorize(principal, READ_ACTION, {
      kind: DESK_KIND,
      workspaceId: principal.workspaceId,
    });
    return principal;
  };

  /** Agent names by id, in batches. */
  const agentNamesOf = async (
    workspaceId: string,
    ids: readonly string[]
  ): Promise<Map<string, string>> => {
    const named = await inBatches(ids, (batch) =>
      db
        .select({ id: agentRows.id, name: agentRows.name })
        .from(agentRows)
        .where(
          and(
            eq(agentRows.workspaceId, workspaceId),
            inArray(agentRows.id, batch)
          )
        )
    );
    return new Map(named.map((agent) => [agent.id, agent.name]));
  };

  /** Trigger and routine names by id, in batches. */
  const triggerNamesOf = async (
    workspaceId: string,
    ids: readonly string[]
  ): Promise<Map<string, string>> => {
    const named = await inBatches(ids, (batch) =>
      db
        .select({ id: triggerRows.id, name: triggerRows.name })
        .from(triggerRows)
        .where(
          and(
            eq(triggerRows.workspaceId, workspaceId),
            inArray(triggerRows.id, batch)
          )
        )
    );
    return new Map(named.map((trigger) => [trigger.id, trigger.name]));
  };

  /** The people behind user ids. A failing lookup logs and names nobody. */
  const peopleOf = async (userIds: readonly string[]) => {
    if (!people || userIds.length === 0) {
      return new Map<string, string>();
    }
    try {
      const found = await people(userIds);
      const labels = new Map<string, string>();
      for (const [id, person] of found) {
        const label = personLabel(person);
        if (label) {
          labels.set(id, label);
        }
      }
      return labels;
    } catch (error) {
      console.error("People lookup failed", error);
      return new Map<string, string>();
    }
  };

  /** Names every starter in a few batched reads, then turns drafts into cards. */
  const named = async (
    workspaceId: string,
    drafts: readonly Draft[]
  ): Promise<DeskCard[]> => {
    const idsOf = (kind: string) =>
      drafts
        .filter(({ starter }) => starter.kind === kind)
        .map(({ starter }) => starter.id);
    const [agentNames, triggerNames, personNames] = await Promise.all([
      agentNamesOf(workspaceId, idsOf("agent")),
      triggerNamesOf(workspaceId, idsOf("trigger")),
      peopleOf([...new Set(idsOf("user"))]),
    ]);
    const nameOf = ({ id, kind }: Starter): string => {
      switch (kind) {
        case "user":
          return personNames.get(id) ?? "A teammate";
        case "agent":
          return agentNames.get(id) ?? "An agent";
        case "trigger":
          return triggerNames.get(id) ?? "A trigger";
        default:
          return "System";
      }
    };
    return drafts.map(({ starter, ...card }) => ({
      ...card,
      startedBy: nameOf(starter),
    }));
  };

  const draftIds = async (workspaceId: string): Promise<Set<string>> =>
    new Set(
      (
        await db
          .select({ id: agentRows.id })
          .from(agentRows)
          .where(
            and(
              eq(agentRows.workspaceId, workspaceId),
              eq(agentRows.status, "draft")
            )
          )
      ).map((row) => row.id)
    );

  /** The open requests that have not expired, oldest first. */
  const pendingRecords = async (
    member: UserPrincipal
  ): Promise<RequestRecord[]> => {
    const now = clock.now().toISOString();
    const drafts = await draftIds(member.workspaceId);
    return (await requests.listPending(member)).filter(
      (record) => record.expiresAt > now && !drafts.has(record.agentId)
    );
  };

  /**
   * What waits on the member as contract C4 lists it, oldest first. A request
   * past its expiry is left out.
   */
  const pendingRequests = async (
    member: UserPrincipal
  ): Promise<NeedsYouItem[]> => {
    const pending = await pendingRecords(member);
    if (pending.length === 0) {
      return [];
    }
    const names = await agentNamesOf(
      member.workspaceId,
      pending.map((record) => record.agentId)
    );
    return pending.map((record) => ({
      agent: names.get(record.agentId) ?? record.agentId,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      kind: record.kind,
      requestId: record.id,
      runId: record.runId,
      ...describe(record),
    }));
  };

  /** Everything in Needs you, before it becomes cards. */
  const needsYouSources = async (member: UserPrincipal) => {
    const [pending, versions, triggerList, routineList, threads, drafts] =
      await Promise.all([
        pendingRecords(member),
        skillsStore.proposals(member),
        triggers.list(member),
        routines.list(member),
        inbox.listThreads(member),
        draftIds(member.workspaceId),
      ]);
    // `list` keeps a rejected trigger, which stays unapproved but is revoked.
    const proposedTriggers = triggerList.filter(
      (trigger) =>
        isPendingProposal(trigger) &&
        trigger.revokedAt === null &&
        !drafts.has(trigger.agentId)
    );
    const proposedRoutines = routineList.filter(
      (routine) => isPendingProposal(routine) && !drafts.has(routine.agentId)
    );
    // The newest post of each listed thread, in one read.
    const threadIds = threads.map((thread) => thread.id);
    const latest = await inBatches(threadIds, (batch) =>
      db
        .select({
          authorId: inboxPosts.authorId,
          authorKind: inboxPosts.authorKind,
          createdAt: inboxPosts.createdAt,
          runId: inboxPosts.runId,
          text: inboxPosts.text,
          threadId: inboxPosts.threadId,
        })
        .from(inboxPosts)
        .where(
          and(
            eq(inboxPosts.workspaceId, member.workspaceId),
            inArray(
              inboxPosts.id,
              db
                .select({ id: max(inboxPosts.id) })
                .from(inboxPosts)
                .where(inArray(inboxPosts.threadId, batch))
                .groupBy(inboxPosts.threadId)
            )
          )
        )
    );
    const answered = threads.flatMap((thread) => {
      const post = latest.find((entry) => entry.threadId === thread.id);
      return post?.authorKind === "agent" && !drafts.has(post.authorId)
        ? [{ post, thread }]
        : [];
    });
    return {
      answered,
      pending,
      proposedRoutines,
      proposedTriggers,
      versions: versions.filter(
        (version) =>
          version.author.kind !== "agent" || !drafts.has(version.author.id)
      ),
    };
  };

  type Sources = Awaited<ReturnType<typeof needsYouSources>>;

  /** The Needs you lane for the member, oldest first. */
  const needsYouCards = async (
    member: UserPrincipal,
    sources: Sources
  ): Promise<DeskCard[]> => {
    const { workspaceId } = member;
    const [runActors, skillNames] = await Promise.all([
      inBatches(
        sources.pending.map((record) => record.runId),
        (batch) =>
          db
            .select({
              actorId: runRows.actorId,
              actorKind: runRows.actorKind,
              id: runRows.id,
            })
            .from(runRows)
            .where(
              and(
                eq(runRows.workspaceId, workspaceId),
                inArray(runRows.id, batch)
              )
            )
      ),
      inBatches(
        sources.versions.map((version) => version.skillId),
        (batch) =>
          db
            .select({
              id: skills.id,
              name: skills.name,
              ownerAgentId: skills.ownerAgentId,
            })
            .from(skills)
            .where(
              and(
                eq(skills.workspaceId, workspaceId),
                inArray(skills.id, batch)
              )
            )
      ),
    ]);
    const actorOf = new Map(runActors.map((run) => [run.id, run]));
    const skillOf = new Map(skillNames.map((skill) => [skill.id, skill]));
    const drafts: Draft[] = [
      ...sources.pending.map(
        (record): Draft => ({
          agentId: record.agentId,
          at: record.createdAt,
          band: statusBand(
            { error: null, resultText: null, status: "waiting" },
            [],
            [record]
          ),
          id: record.id,
          kind: "request",
          lane: "needs_you",
          needsYouKind: record.kind,
          runId: record.runId,
          starter: {
            id: actorOf.get(record.runId)?.actorId ?? "",
            kind: actorOf.get(record.runId)?.actorKind ?? "system",
          },
          title: describe(record).title,
        })
      ),
      ...sources.versions.map((version): Draft => {
        const skill = skillOf.get(version.skillId);
        return {
          agentId:
            version.author.kind === "agent"
              ? version.author.id
              : (skill?.ownerAgentId ?? ""),
          at: version.createdAt,
          band: {
            text: clip(
              `Proposes version ${version.number}: ${version.message}`,
              TITLE_MAX
            ),
            tone: "waiting",
          },
          id: version.id,
          kind: "proposal",
          lane: "needs_you",
          needsYouKind: "skill_proposal",
          starter: version.author,
          title: skill?.name ?? "Skill",
        };
      }),
      ...sources.proposedTriggers.map(
        (trigger): Draft => ({
          agentId: trigger.agentId,
          at: trigger.createdAt,
          band: { text: "Proposes a trigger", tone: "waiting" },
          id: trigger.id,
          kind: "proposal",
          lane: "needs_you",
          needsYouKind: "trigger_proposal",
          starter: {
            id: trigger.proposedByAgentId ?? trigger.agentId,
            kind: "agent",
          },
          title: trigger.name,
        })
      ),
      ...sources.proposedRoutines.map(
        (routine): Draft => ({
          agentId: routine.agentId,
          at: routine.createdAt,
          band: { text: "Proposes a routine", tone: "waiting" },
          id: routine.id,
          kind: "proposal",
          lane: "needs_you",
          needsYouKind: "routine_proposal",
          starter: {
            id: routine.proposedByAgentId ?? routine.agentId,
            kind: "agent",
          },
          title: routine.name,
        })
      ),
      ...sources.answered.map(
        ({ post, thread }): Draft => ({
          agentId: post.authorId,
          at: post.createdAt,
          band: {
            text: clip(`Replied: ${text(post.text)}`, TITLE_MAX),
            tone: "waiting",
          },
          id: thread.id,
          kind: "thread",
          lane: "needs_you",
          needsYouKind: "inbox_reply",
          ...(post.runId ? { runId: post.runId } : {}),
          starter: { id: post.authorId, kind: "agent" },
          threadId: thread.id,
          title: thread.title,
        })
      ),
    ];
    return (await named(workspaceId, drafts)).sort(byAge);
  };

  /** Run cards for `lane`, each with its band. Ordered as `rows` are. */
  const runCards = async (
    member: UserPrincipal,
    lane: "done" | "running",
    rows: readonly (typeof runRows.$inferSelect)[],
    pending: readonly RequestRecord[]
  ): Promise<DeskCard[]> => {
    const eventsByRun = await latestBandEvents(
      db,
      rows.filter((run) => run.status === "running").map((run) => run.id)
    );
    const drafts = rows.map(
      (run): Draft => ({
        agentId: run.agentId,
        at:
          lane === "done"
            ? (run.finishedAt ?? run.createdAt)
            : (run.startedAt ?? run.createdAt),
        band: statusBand(
          run,
          eventsByRun.get(run.id) ?? [],
          pending.filter((record) => record.runId === run.id)
        ),
        id: run.id,
        kind: "run",
        lane,
        runId: run.id,
        starter: { id: run.actorId, kind: run.actorKind },
        title: titleOf(run.inputText),
      })
    );
    return await named(member.workspaceId, drafts);
  };

  const get = async (
    principal: Principal,
    rawInput: DeskInput
  ): Promise<DeskView> => {
    const member = requireMember(principal);
    const { agentId, dayStart } = deskInputSchema.parse(rawInput);
    const since = new Date(dayStart).toISOString();
    const sources = await needsYouSources(member);
    const visible = inArray(
      runRows.sessionId,
      db
        .select({ id: sessions.id })
        .from(sessions)
        .where(await visibleSessions(db, member))
    );
    const mine = and(
      eq(runRows.workspaceId, member.workspaceId),
      visible,
      // Dry runs on builder drafts stay in the builder, including their totals.
      inArray(
        runRows.agentId,
        db
          .select({ id: agentRows.id })
          .from(agentRows)
          .where(
            and(
              eq(agentRows.workspaceId, member.workspaceId),
              ne(agentRows.status, "draft")
            )
          )
      ),
      agentId === undefined ? undefined : eq(runRows.agentId, agentId)
    );
    const doneWhere = and(
      mine,
      inArray(runRows.status, [...FINISHED_STATUSES]),
      gte(runRows.finishedAt, since)
    );
    const [liveRows, doneRows, [total]] = await Promise.all([
      db
        .select()
        .from(runRows)
        .where(and(mine, inArray(runRows.status, [...LIVE_STATUSES])))
        .orderBy(desc(runRows.createdAt), desc(runRows.id)),
      db
        .select()
        .from(runRows)
        .where(doneWhere)
        .orderBy(desc(runRows.finishedAt), desc(runRows.id))
        .limit(DONE_CAP),
      db.select({ n: count() }).from(runRows).where(doneWhere),
    ]);
    const [needsYou, running, done] = await Promise.all([
      needsYouCards(member, sources),
      runCards(member, "running", liveRows, sources.pending),
      runCards(member, "done", doneRows, []),
    ]);
    return {
      done,
      doneMore: Math.max(0, (total?.n ?? 0) - doneRows.length),
      needsYou:
        agentId === undefined
          ? needsYou
          : needsYou.filter((card) => card.agentId === agentId),
      running,
    };
  };

  /** How many cards the Needs you lane holds, for the sidebar badge. */
  const needsYouCount = async (principal: Principal): Promise<number> => {
    const member = requireMember(principal);
    const sources = await needsYouSources(member);
    return (
      sources.pending.length +
      sources.versions.length +
      sources.proposedTriggers.length +
      sources.proposedRoutines.length +
      sources.answered.length
    );
  };

  return { get, needsYouCount, pendingRequests };
};

export type DeskService = ReturnType<typeof createDeskService>;
