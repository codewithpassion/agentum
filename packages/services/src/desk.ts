/**
 * The desk home: three lanes over runs, inbox threads and pending approvals,
 * and the Needs you count for the rail. One call computes them so the
 * page and the count read the same things.
 *
 * Needs you holds what waits on a person: open approvals and questions,
 * proposed skill versions, triggers and routines, and inbox threads an agent
 * answered last. Running holds the live runs, and Done today the runs that
 * finished since the viewer's midnight. Every lane follows the sessions rules,
 * so another member's ui session or private Slack DM never shows.
 */
import type { Database } from "@repo/db";
import { agents as agentRows } from "@repo/db/schema/agents";
import {
  artifactGrants,
  artifacts,
  artifactVersions,
} from "@repo/db/schema/artifacts";
import { inboxPosts } from "@repo/db/schema/inbox";
import { libraryConflicts, wikiSuggestions } from "@repo/db/schema/library";
import { mailMessages } from "@repo/db/schema/mail";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { skills } from "@repo/db/schema/skills";
import { triggers as triggerRows } from "@repo/db/schema/triggers";
import {
  type DeskCard,
  isPendingProposal,
  type RunStatus,
} from "@repo/db/shared";
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  max,
  ne,
  or,
} from "drizzle-orm";
import { z } from "zod";
import type { A2aNeedsYouSource } from "./a2a/needs-you.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { personLabel } from "./events/summary.ts";
import type { PeopleLookup } from "./events.ts";
import type { InboxService } from "./inbox.ts";
import { isA2aApproval } from "./mail/approval.ts";
import { mailSubjectsOf } from "./mail-subjects.ts";
import { runTitleText } from "./mail-title-text.ts";
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

/** How far back a failed or bounced run still needs a person (rail rule 9). */
const STUCK_WINDOW_MS = 7 * 24 * 60 * 60_000;

const READ_ACTION = "desk.read";
const DESK_KIND = "desk";

const LIVE_STATUSES: readonly RunStatus[] = [
  "queued",
  "offered",
  "running",
  "waiting",
];
const STUCK_STATUSES: readonly RunStatus[] = ["failed", "interrupted"];
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

/** A run that needs a person because it did not finish well. */
export interface StuckRun {
  card: DeskCard;
  problem: "bounced" | "failed" | "interrupted";
}

/** What the rail reads from the desk. See `railSources`. */
export interface RailSources {
  /** Each run that finished since the viewer's midnight, with its agent. */
  done: { agentId: string; runId: string }[];
  needsYou: DeskCard[];
  /**
   * The runs of the live, done and stuck lists, and behind open requests, that only the viewer can see:
   * their session is a UI or private one the viewer opened. Unique.
   */
  ownRunIds: string[];
  /** The open, unexpired requests behind the approval, question and takeover cards. */
  pending: RequestRecord[];
  running: DeskCard[];
  stuck: StuckRun[];
  /** The live runs that wait on a person; the rail lists them under Needs you only. */
  waitingRunIds: string[];
}

/** One thing waiting on the member, as C4 lists it. */
export interface NeedsYouItem {
  agent: string;
  createdAt: string;
  detail: string;
  expiresAt: string;
  kind: "approval" | "question" | "takeover";
  requestId: string;
  runId: string;
  title: string;
}

const clip = (value: string, limit: number = DETAIL_MAX): string =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/** Title and detail from the stored, already scrubbed display. */
const describe = (record: RequestRecord): { detail: string; title: string } => {
  const { display } = record;
  if ("machineId" in display) {
    return { detail: display.reason, title: "Take over the computer" };
  }
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

/** The title of a card for a GitHub update that a person proposed. */
const GITHUB_UPDATE_TITLE = "Update from GitHub to review";

/** Why a run needs a person: bounced mail wins over how the run ended. */
const problemOf = (
  bounced: boolean,
  status: RunStatus | undefined
): StuckRun["problem"] => {
  if (bounced) {
    return "bounced";
  }
  return status === "interrupted" ? "interrupted" : "failed";
};

/** The host of an origin such as `https://peer.example`, or null when it is not a URL. */
const hostOf = (origin: string | null): string | null => {
  if (origin === null) {
    return null;
  }
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
};

const byAge = (a: DeskCard, b: DeskCard): number =>
  a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at);

/**
 * The first line of what was asked, as a card title. A run started by mail
 * takes its mail's subject. Its first line is a notice to the agent, which no
 * card shows.
 */
const titleOf = (inputText: string, mailSubject?: string): string => {
  const [line] = text(inputText).split("\n");
  return clip(
    runTitleText(line?.trim() ?? "", mailSubject) || "Task",
    TITLE_MAX
  );
};

export const createDeskService = ({
  a2a,
  clock,
  db,
  inbox,
  people,
  requests,
  routines,
  skillsStore,
  triggers,
}: {
  a2a?: A2aNeedsYouSource;
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
    drafts: readonly Draft[],
    peerNames: ReadonlyMap<string, string> = new Map()
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
        case "peer":
          return peerNames.get(id) ?? "A peer";
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
    return pending.map((record) => {
      const described = describe(record);
      return {
        agent: names.get(record.agentId) ?? record.agentId,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        kind: record.kind,
        requestId: record.id,
        runId: record.runId,
        ...described,
        detail: sendDetail(record) ?? described.detail,
      };
    });
  };

  /**
   * The whole message behind an `a2a_send` card, never clipped: a person must
   * see all of what an approval sends. It comes from the card's input, which is
   * scrubbed. Null for any other request, and for a card that holds only a cut copy.
   */
  const sendDetail = (record: RequestRecord): string | null => {
    if (!(isA2aApproval(record) && "input" in record.display)) {
      return null;
    }
    const { input } = record.display;
    if (typeof input === "object" && input !== null && !Array.isArray(input)) {
      const { peer, host, text: shownText } = input as Record<string, unknown>;
      if (typeof shownText === "string") {
        return `To ${String(peer)} at ${String(host)}, an agent outside this workspace:\n\n${shownText}`;
      }
    }
    // A card that holds only a cut copy cannot occur, because `send` closes one
    // and refuses the message. Were one to appear, it shows the cut copy, and the
    // desk API refuses to allow it.
    return null;
  };

  /** The A2A messages and connections that wait on a person, before the draft filter. */
  const a2aWaiting = async (member: UserPrincipal) => {
    if (!a2a) {
      return { connections: [], messages: [] };
    }
    const [messages, connections] = await Promise.all([
      a2a.tasks.listWaiting(member),
      a2a.connections.list(member),
    ]);
    return {
      connections: connections.filter(
        (connection) => connection.status === "needs_approval"
      ),
      messages,
    };
  };

  /** Everything in Needs you, before it becomes cards. */
  const needsYouSources = async (member: UserPrincipal) => {
    const [
      pending,
      versions,
      triggerList,
      routineList,
      threads,
      drafts,
      conflicts,

      suggestions,
      a2aList,
    ] = await Promise.all([
      pendingRecords(member),
      skillsStore.proposals(member),
      triggers.list(member),
      routines.list(member),
      inbox.listThreads(member),
      draftIds(member.workspaceId),
      db
        .select()
        .from(libraryConflicts)
        .where(
          and(
            eq(libraryConflicts.workspaceId, member.workspaceId),
            eq(libraryConflicts.status, "open")
          )
        ),
      db
        .select()
        .from(wikiSuggestions)
        .where(
          and(
            eq(wikiSuggestions.workspaceId, member.workspaceId),
            inArray(wikiSuggestions.status, ["pending", "stale"])
          )
        ),
      a2aWaiting(member),
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
      // A dismissal holds until a post newer than it lands.
      const dismissed =
        post !== undefined &&
        thread.attentionClearedAt !== null &&
        thread.attentionClearedAt >= post.createdAt;
      return post?.authorKind === "agent" &&
        !drafts.has(post.authorId) &&
        !dismissed
        ? [{ post, thread }]
        : [];
    });
    return {
      a2aConnections: a2aList.connections.filter(
        (connection) => !drafts.has(connection.agentId)
      ),
      a2aMessages: a2aList.messages.filter(
        (message) => !drafts.has(message.agentId)
      ),
      answered,
      appGrants: await db
        .select({
          artifactId: artifacts.id,
          at: artifactGrants.createdAt,
          id: artifactVersions.id,
          ownerUserId: artifacts.ownerUserId,
          title: artifacts.title,
        })
        .from(artifactGrants)
        .innerJoin(
          artifactVersions,
          eq(artifactVersions.id, artifactGrants.versionId)
        )
        .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
        .where(
          and(
            eq(artifacts.workspaceId, member.workspaceId),
            isNull(artifacts.deletedAt),
            eq(artifactVersions.authorKind, "user"),
            eq(artifactVersions.id, artifacts.currentVersionId),
            eq(artifactGrants.status, "pending"),
            eq(artifacts.ownerUserId, member.userId)
          )
        )
        .groupBy(artifactVersions.id),
      conflicts: conflicts.filter((row) => !drafts.has(row.agentId)),
      pending,
      proposedRoutines,
      proposedTriggers,
      suggestions: suggestions.filter(
        (suggestion) => !drafts.has(suggestion.agentId)
      ),
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
      ...sources.appGrants.map(
        (grant): Draft => ({
          actorKind: "user",
          agentId: "",
          artifactId: grant.artifactId,
          at: grant.at,
          band: {
            text: "Approve this app version’s access",
            tone: "waiting",
          },
          id: grant.id,
          kind: "proposal",
          lane: "needs_you",
          needsYouKind: "artifact_grant",
          starter: { id: grant.ownerUserId ?? member.userId, kind: "user" },
          title: grant.title,
        })
      ),
      ...sources.conflicts.map(
        (conflict): Draft => ({
          agentId: conflict.agentId,
          at: conflict.createdAt,
          band: { text: "Choose which file to keep", tone: "waiting" },
          id: conflict.id,
          kind: "conflict",
          lane: "needs_you",
          needsYouKind: "library_conflict",
          ...(conflict.runId ? { runId: conflict.runId } : {}),
          starter: { id: conflict.agentId, kind: "agent" },
          title: conflict.path,
        })
      ),
      ...sources.suggestions.map(
        (suggestion): Draft => ({
          agentId: suggestion.agentId,
          at: suggestion.createdAt,
          band: { text: clip(suggestion.summary, TITLE_MAX), tone: "waiting" },
          id: suggestion.id,
          kind: "proposal",
          lane: "needs_you",
          needsYouKind: "wiki_suggestion",
          ...(suggestion.runId ? { runId: suggestion.runId } : {}),
          starter: { id: suggestion.agentId, kind: "agent" },
          title: suggestion.path,
        })
      ),
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
        const skillName = skill?.name ?? "Skill";
        const proposes = `Proposes version ${version.number}`;
        // Only a person's `importUpdate` proposes a version as a user.
        if (version.author.kind === "user") {
          return {
            actorKind: "user",
            agentId: skill?.ownerAgentId ?? "",
            at: version.createdAt,
            band: {
              text: clip(`${skillName}: ${proposes}`, TITLE_MAX),
              tone: "waiting",
            },
            id: version.id,
            kind: "proposal",
            lane: "needs_you",
            needsYouKind: "skill_proposal",
            starter: version.author,
            title: GITHUB_UPDATE_TITLE,
          };
        }
        return {
          agentId:
            version.author.kind === "agent"
              ? version.author.id
              : (skill?.ownerAgentId ?? ""),
          at: version.createdAt,
          band: {
            text: clip(`${proposes}: ${version.message}`, TITLE_MAX),
            tone: "waiting",
          },
          id: version.id,
          kind: "proposal",
          lane: "needs_you",
          needsYouKind: "skill_proposal",
          starter: version.author,
          title: skillName,
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
      ...sources.a2aMessages.map(
        (message): Draft => ({
          a2a: {
            checkCode: null,
            connectionId: message.connectionId,
            host: message.host,
            org: message.org,
            peer: message.peer,
            text: message.text,
          },
          agentId: message.agentId,
          at: message.createdAt,
          band: { text: message.text, tone: "waiting" },
          id: message.taskId,
          kind: "request",
          lane: "needs_you",
          needsYouKind: "a2a_message",
          starter: { id: message.connectionId, kind: "peer" },
          title: `${message.peer} sent a message`,
        })
      ),
      ...sources.a2aConnections.map((connection): Draft => {
        const peer = connection.peerLabel ?? "An outside agent";
        const host = hostOf(connection.pendingOrigin ?? connection.peerOrigin);
        const where = host === null ? "" : ` at ${host}`;
        const code =
          connection.checkCode === null
            ? ""
            : ` Check code ${connection.checkCode}.`;
        return {
          a2a: {
            checkCode: connection.checkCode,
            connectionId: connection.id,
            host,
            org: connection.peerOrg,
            peer,
            text: null,
          },
          agentId: connection.agentId,
          at: connection.createdAt,
          band: {
            text: `${peer}${where} wants to connect to ${connection.agentName}.${code}`,
            tone: "waiting",
          },
          id: connection.id,
          kind: "request",
          lane: "needs_you",
          needsYouKind: "a2a_connection",
          starter: { id: connection.id, kind: "peer" },
          title: `${peer} wants to connect`,
        };
      }),
    ];
    // A peer starter is named by its connection, so each one maps to its peer.
    const peerNames = new Map<string, string>([
      ...sources.a2aMessages.map(
        (message) => [message.connectionId, message.peer] as const
      ),
      ...sources.a2aConnections.map(
        (connection) =>
          [connection.id, connection.peerLabel ?? "An outside agent"] as const
      ),
    ]);
    return (await named(workspaceId, drafts, peerNames)).sort(byAge);
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
    const bounced = await inBatches(
      rows.map((run) => run.id),
      (batch) =>
        db
          .select({ runId: mailMessages.runId, to: mailMessages.toAddresses })
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.workspaceId, member.workspaceId),
              eq(mailMessages.direction, "out"),
              eq(mailMessages.status, "bounced"),
              inArray(mailMessages.runId, batch)
            )
          )
    );
    // A run started by mail is titled by the mail's subject.
    const subjectOf = await mailSubjectsOf(
      db,
      member.workspaceId,
      rows.map((run) => run.id)
    );
    const bouncedBands = new Map(
      bounced.map((message) => {
        let address = "recipient";
        try {
          const recipients = JSON.parse(message.to) as (
            | string
            | { address: string }
          )[];
          address =
            recipients
              .map((recipient) =>
                typeof recipient === "string" ? recipient : recipient.address
              )
              .join(", ") || address;
        } catch {
          /* Keep the error visible even for a malformed historic address. */
        }
        return [
          message.runId,
          { text: `Mail to ${address} bounced`, tone: "error" as const },
        ] as const;
      })
    );
    const drafts = rows.map(
      (run): Draft => ({
        agentId: run.agentId,
        at:
          lane === "done"
            ? (run.finishedAt ?? run.createdAt)
            : (run.startedAt ?? run.createdAt),
        band:
          bouncedBands.get(run.id) ??
          statusBand(
            run,
            eventsByRun.get(run.id) ?? [],
            pending.filter((record) => record.runId === run.id)
          ),
        id: run.id,
        kind: "run",
        lane,
        runId: run.id,
        starter: { id: run.actorId, kind: run.actorKind },
        title: titleOf(run.inputText, subjectOf.get(run.id)),
      })
    );
    return await named(member.workspaceId, drafts);
  };

  /** The runs the member may see on the desk: session rules, no dry runs, no builder drafts. */
  const visibleRuns = async (member: UserPrincipal, agentId?: string) => {
    const visible = inArray(
      runRows.sessionId,
      db
        .select({ id: sessions.id })
        .from(sessions)
        .where(await visibleSessions(db, member))
    );
    return and(
      eq(runRows.workspaceId, member.workspaceId),
      visible,
      // Dry runs never show on the desk, not even to the builder who started them.
      eq(runRows.dryRun, false),
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
  };

  const get = async (
    principal: Principal,
    rawInput: DeskInput
  ): Promise<DeskView> => {
    const member = requireMember(principal);
    const { agentId, dayStart } = deskInputSchema.parse(rawInput);
    const since = new Date(dayStart).toISOString();
    const sources = await needsYouSources(member);
    const mine = await visibleRuns(member, agentId);
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

  /**
   * What the rail needs from the desk, under the desk's own visibility rules:
   * the Needs you cards with the open requests behind them, the live runs, the
   * runs that finished since `dayStart`, and runs that failed or bounced mail
   * in the last 7 days and have not been dismissed. `ownRunIds` marks the runs
   * among them, and behind open requests, that only the viewer can see.
   */
  const railSources = async (
    principal: Principal,
    rawInput: { dayStart: string }
  ): Promise<RailSources> => {
    const member = requireMember(principal);
    const { dayStart } = deskInputSchema
      .pick({ dayStart: true })
      .parse(rawInput);
    const since = new Date(dayStart).toISOString();
    const stuckSince = new Date(
      clock.now().getTime() - STUCK_WINDOW_MS
    ).toISOString();
    const sources = await needsYouSources(member);
    const mine = await visibleRuns(member);
    const ownSessions = db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.workspaceId, member.workspaceId),
          eq(sessions.actorId, member.userId),
          or(eq(sessions.origin, "ui"), eq(sessions.private, true))
        )
      );
    const bouncedRuns = db
      .select({ id: mailMessages.runId })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.workspaceId, member.workspaceId),
          eq(mailMessages.direction, "out"),
          eq(mailMessages.status, "bounced"),
          gte(mailMessages.createdAt, stuckSince)
        )
      );
    const [liveRows, doneRows, stuckRows, bouncedIds] = await Promise.all([
      db
        .select()
        .from(runRows)
        .where(and(mine, inArray(runRows.status, [...LIVE_STATUSES])))
        .orderBy(desc(runRows.createdAt), desc(runRows.id)),
      db
        .select({ agentId: runRows.agentId, runId: runRows.id })
        .from(runRows)
        .where(
          and(
            mine,
            inArray(runRows.status, [...FINISHED_STATUSES]),
            gte(runRows.finishedAt, since)
          )
        ),
      db
        .select()
        .from(runRows)
        .where(
          and(
            mine,
            isNull(runRows.attentionClearedAt),
            or(
              and(
                inArray(runRows.status, [...STUCK_STATUSES]),
                gte(runRows.finishedAt, stuckSince)
              ),
              inArray(runRows.id, bouncedRuns)
            )
          )
        )
        .orderBy(desc(runRows.createdAt), desc(runRows.id)),
      bouncedRuns,
    ]);
    const bounced = new Set(bouncedIds.map((row) => row.id));
    const [needsYou, running, stuckCards, ownRunIds] = await Promise.all([
      needsYouCards(member, sources),
      runCards(member, "running", liveRows, sources.pending),
      runCards(member, "done", stuckRows, []),
      inBatches(
        [
          ...liveRows.map((row) => row.id),
          ...doneRows.map((row) => row.runId),
          ...stuckRows.map((row) => row.id),
          // A held mail outlives its run, so an open request can name a run
          // that is neither live nor just finished.
          ...sources.pending.map((record) => record.runId),
        ],
        (batch) =>
          db
            .select({ id: runRows.id })
            .from(runRows)
            .where(
              and(
                inArray(runRows.id, batch),
                inArray(runRows.sessionId, ownSessions)
              )
            )
      ).then((rows) => [...new Set(rows.map((row) => row.id))]),
    ]);
    return {
      done: doneRows,
      needsYou,
      ownRunIds,
      pending: sources.pending,
      running,
      stuck: stuckCards.map((card) => ({
        card,
        problem: problemOf(
          bounced.has(card.id),
          stuckRows.find((row) => row.id === card.id)?.status
        ),
      })),
      waitingRunIds: liveRows
        .filter((row) => row.status === "waiting")
        .map((row) => row.id),
    };
  };

  /** How many cards the Needs you lane holds, for the rail. */
  const needsYouCount = async (principal: Principal): Promise<number> => {
    const member = requireMember(principal);
    const sources = await needsYouSources(member);
    return (
      sources.appGrants.length +
      sources.conflicts.length +
      sources.suggestions.length +
      sources.pending.length +
      sources.versions.length +
      sources.proposedTriggers.length +
      sources.proposedRoutines.length +
      sources.answered.length +
      sources.a2aMessages.length +
      sources.a2aConnections.length
    );
  };

  return { get, needsYouCount, pendingRequests, railSources };
};

export type DeskService = ReturnType<typeof createDeskService>;
