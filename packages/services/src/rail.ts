/**
 * The rail: what waits on a person, who it is for, and what is running. It
 * reads through the desk service so the desk's visibility rules stay in one
 * place, then adds who each item is for, when it is due and how it reads.
 *
 * Assignment is visibility, not permission (rule 3): any member can still
 * answer any request, and authorisation does not change. Escalation is
 * computed on read from the age of an item (rule 4).
 */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { mailMessages } from "@repo/db/schema/mail";
import { runs as runRows } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import {
  MAIL_SEND_TOOL,
  type RailCard,
  type RailItem,
  type RailMail,
  type RailSetupStep,
  type RailView,
  type RailWorking,
} from "@repo/db/shared";
import { and, count, eq, gte, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AgentRecord, AgentsService } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import type { DeskService } from "./desk.ts";
import { ServiceError } from "./errors.ts";
import { personLabel } from "./events/summary.ts";
import type { PeopleLookup } from "./events.ts";
import type { ManagedKeysService } from "./managed/keys.ts";
import type { MembersService } from "./members.ts";
import type { ModelKeysService } from "./model-keys.ts";
import {
  assigneeOf,
  dueFrom,
  escalationTarget,
  groupKey,
  isMine,
  mailTitle,
  plainStatus,
  plainTitle,
  sortNeedsYou,
} from "./rail/logic.ts";
import type { RequestRecord } from "./requests.ts";
import type { Clock } from "./runs/types.ts";
import { visibleSessions } from "./sessions.ts";
import { inBatches } from "./tasks/reads.ts";
import type { Principal } from "./workspaces.ts";

/** The longest reply a mail card carries. */
const MAIL_BODY_MAX = 4000;

/** The tool use id of a held mail approval is this prefix plus the message id. */
const MAIL_USE_PREFIX = "mail:";

const READ_ACTION = "rail.read";
const CLEAR_ACTION = "rail.clear";
const RAIL_KIND = "rail";

export const railInputSchema = z.strictObject({
  /** The viewer's local midnight, as an ISO time. */
  dayStart: z.iso.datetime(),
  scope: z.enum(["mine", "everyone"]),
});
export type RailInput = z.input<typeof railInputSchema>;

/** What one agent is doing, for the Agents table. */
export interface AgentOverview {
  agentId: string;
  /** Tasks the member can see that started in the last 7 days. */
  tasksThisWeek: number;
  /** Open requests and takeovers that wait on a person. */
  waiting: number;
  /** Live runs that do not wait on a person. */
  working: number;
}

const WEEK_MS = 7 * 24 * 60 * 60_000;

export const clearAttentionInputSchema = z.strictObject({
  runId: z.string().min(1).max(200),
});

type UserPrincipal = Extract<Principal, { kind: "user" }>;

/** The approval input of a held mail, as `mail/outbound.ts` writes it. */
const heldMailInput = z.object({
  preview: z.string().optional(),
  subject: z.string().optional(),
  to: z.array(z.string()).optional(),
});

const addressList = z.array(z.string());

const senderSchema = z.object({
  address: z.string(),
  name: z.string().optional(),
});

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};

const clip = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/** The people of the organisation, or nothing when Clerk could not say. */
interface Directory {
  ids: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
}

/** A decision before it is grouped into a row. */
interface Candidate {
  assigneeUserId: string | null;
  card: RailCard;
  dueAt: string | null;
  escalatedToMe: boolean;
  groupKey: string | null;
}

/** What the rail knows about a held mail. */
interface HeldMail {
  inboundAt: string | null;
  mail: RailMail;
  recipientName: string | null;
  threadId: string;
}

const byCardAge = (a: RailCard, b: RailCard): number =>
  a.at === b.at ? a.id.localeCompare(b.id) : a.at.localeCompare(b.at);

type MailRow = typeof mailMessages.$inferSelect;

/** One held mail: what is being sent, and the message it answers if there is one. */
const heldMailOf = (
  record: RequestRecord,
  message: MailRow,
  reply: MailRow | undefined
): HeldMail => {
  const input =
    "input" in record.display
      ? heldMailInput.safeParse(record.display.input)
      : null;
  const stored = input?.success ? input.data : {};
  const to =
    stored.to ?? addressList.catch([]).parse(parseJson(message.toAddresses));
  const sender = reply
    ? senderSchema.safeParse(parseJson(reply.fromAddress))
    : null;
  const addressedToSender =
    sender?.success === true &&
    sender.data.address.toLowerCase() === to.at(0)?.toLowerCase();
  return {
    inboundAt: reply?.createdAt ?? null,
    mail: {
      body: clip(stored.preview ?? message.snippet, MAIL_BODY_MAX),
      subject: mailTitle(stored.subject ?? message.subject),
      theyWrote: reply?.snippet ?? null,
      to,
    },
    recipientName:
      addressedToSender && sender?.success ? (sender.data.name ?? null) : null,
    threadId: message.threadId,
  };
};

export const createRailService = ({
  agents,
  atomic,
  clock,
  db,
  desk,
  managedKeys,
  members,
  modelKeys,
  people,
}: {
  agents: Pick<AgentsService, "list">;
  atomic: Atomic;
  clock: Clock;
  db: Database;
  desk: Pick<DeskService, "railSources">;
  managedKeys: Pick<ManagedKeysService, "status">;
  members: Pick<MembersService, "list">;
  modelKeys: Pick<ModelKeysService, "configuredProviders">;
  people?: PeopleLookup;
}) => {
  const requireMember = (principal: Principal, action: string) => {
    if (principal.kind !== "user") {
      throw new ForbiddenError(action);
    }
    authorize(principal, action, {
      kind: RAIL_KIND,
      workspaceId: principal.workspaceId,
    });
    return principal;
  };

  /** The member list, or null when the lookup fails: Mine then shows everything. */
  const directoryOf = async (
    member: UserPrincipal
  ): Promise<Directory | null> => {
    try {
      const list = await members.list(member);
      return {
        ids: new Set(list.map((entry) => entry.userId)),
        names: new Map(list.map((entry) => [entry.userId, entry.name])),
      };
    } catch (error) {
      console.error("Member lookup failed", error);
      return null;
    }
  };

  /** Names for user ids the member list did not name. Best effort. */
  const peopleNames = async (
    userIds: readonly string[]
  ): Promise<Map<string, string>> => {
    const labels = new Map<string, string>();
    if (!people || userIds.length === 0) {
      return labels;
    }
    try {
      for (const [id, person] of await people(userIds)) {
        const label = personLabel(person);
        if (label) {
          labels.set(id, label);
        }
      }
    } catch (error) {
      console.error("People lookup failed", error);
    }
    return labels;
  };

  /** The held mails behind mail approvals, with the message they answer. */
  const heldMails = async (
    workspaceId: string,
    pending: readonly RequestRecord[]
  ): Promise<Map<string, HeldMail>> => {
    const records = pending.filter(
      (record) =>
        record.toolName === MAIL_SEND_TOOL &&
        record.toolUseId.startsWith(MAIL_USE_PREFIX)
    );
    const held = new Map<string, HeldMail>();
    if (records.length === 0) {
      return held;
    }
    const outgoing = await inBatches(
      records.map((record) => record.toolUseId.slice(MAIL_USE_PREFIX.length)),
      (batch) =>
        db
          .select()
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.workspaceId, workspaceId),
              inArray(mailMessages.id, batch)
            )
          )
    );
    const incoming = await inBatches(
      [...new Set(outgoing.map((message) => message.threadId))],
      (batch) =>
        db
          .select()
          .from(mailMessages)
          .where(
            and(
              eq(mailMessages.workspaceId, workspaceId),
              eq(mailMessages.direction, "in"),
              inArray(mailMessages.threadId, batch)
            )
          )
    );
    const latestIn = new Map<string, (typeof incoming)[number]>();
    for (const message of incoming) {
      const seen = latestIn.get(message.threadId);
      if (!seen || seen.createdAt < message.createdAt) {
        latestIn.set(message.threadId, message);
      }
    }
    const outgoingById = new Map(
      outgoing.map((message) => [message.id, message])
    );
    for (const record of records) {
      const message = outgoingById.get(
        record.toolUseId.slice(MAIL_USE_PREFIX.length)
      );
      if (message) {
        held.set(
          record.id,
          heldMailOf(record, message, latestIn.get(message.threadId))
        );
      }
    }
    return held;
  };

  /** Who passed each run on: the agent that started it, else its parent's agent. */
  const passedOnByRun = async (
    workspaceId: string,
    runIds: readonly string[],
    agentNames: ReadonlyMap<string, string>
  ): Promise<Map<string, string>> => {
    const rows = await inBatches([...new Set(runIds)], (batch) =>
      db
        .select({
          actorId: runRows.actorId,
          actorKind: runRows.actorKind,
          id: runRows.id,
          parentRunId: runRows.parentRunId,
        })
        .from(runRows)
        .where(
          and(eq(runRows.workspaceId, workspaceId), inArray(runRows.id, batch))
        )
    );
    const parentIds = rows.flatMap((row) =>
      row.parentRunId === null ? [] : [row.parentRunId]
    );
    const parents = await inBatches([...new Set(parentIds)], (batch) =>
      db
        .select({ agentId: runRows.agentId, id: runRows.id })
        .from(runRows)
        .where(
          and(eq(runRows.workspaceId, workspaceId), inArray(runRows.id, batch))
        )
    );
    const parentAgent = new Map(parents.map((row) => [row.id, row.agentId]));
    const passed = new Map<string, string>();
    for (const row of rows) {
      const fromAgent =
        row.actorKind === "agent"
          ? row.actorId
          : parentAgent.get(row.parentRunId ?? "");
      if (fromAgent !== undefined) {
        passed.set(row.id, agentNames.get(fromAgent) ?? "another agent");
      }
    }
    return passed;
  };

  const get = async (
    principal: Principal,
    rawInput: RailInput
  ): Promise<RailView> => {
    const member = requireMember(principal, READ_ACTION);
    const { dayStart, scope } = railInputSchema.parse(rawInput);
    const [sources, agentList, directory, providers, anthropic] =
      await Promise.all([
        desk.railSources(member, { dayStart }),
        agents.list(member, { includeArchived: true }),
        directoryOf(member),
        modelKeys.configuredProviders(member),
        managedKeys.status(member),
      ]);
    const now = clock.now();
    const memberIds = directory?.ids ?? null;
    const agentOf = new Map(agentList.map((agent) => [agent.id, agent]));
    const agentNames = new Map(
      agentList.map((agent) => [agent.id, agent.name])
    );
    const assigneeFor = (agent: AgentRecord | undefined): string | null =>
      agent ? assigneeOf(agent, memberIds) : null;
    const mineFor = (assigneeUserId: string | null, escalatedToMe: boolean) =>
      isMine({
        assigneeUserId,
        escalatedToMe,
        memberLookupFailed: directory === null,
        userId: member.userId,
      });

    const pendingById = new Map(
      sources.pending.map((record) => [record.id, record])
    );
    const [held, passedOn] = await Promise.all([
      heldMails(member.workspaceId, sources.pending),
      passedOnByRun(
        member.workspaceId,
        [
          ...sources.needsYou.flatMap((card) => card.runId ?? []),
          ...sources.running.map((card) => card.id),
          ...sources.stuck.map(({ card }) => card.id),
        ],
        agentNames
      ),
    ]);

    const candidate = (card: RailCard, mail: HeldMail | null): Candidate => {
      const agent = agentOf.get(card.agentId);
      const assigneeUserId = assigneeFor(agent);
      const target = escalationTarget({
        assigneeUserId,
        at: card.at,
        backupUserId: agent?.backupUserId ?? null,
        memberIds,
        now,
      });
      return {
        assigneeUserId,
        card,
        dueAt: mail
          ? dueFrom(`${mail.mail.subject}\n${mail.mail.theyWrote ?? ""}`, {
              dayStart,
              messageAt: mail.inboundAt ?? card.at,
            })
          : null,
        escalatedToMe: target === member.userId,
        groupKey: mail ? groupKey(mail.mail.to) : null,
      };
    };

    const candidates: Candidate[] = [
      ...sources.needsYou.map((deskCard) => {
        const record = pendingById.get(deskCard.id);
        const mail = held.get(deskCard.id) ?? null;
        const kind = deskCard.needsYouKind ?? "approval";
        const agentName =
          agentNames.get(deskCard.agentId) ?? deskCard.startedBy;
        const facts = {
          agentName,
          kind,
          mail: mail
            ? {
                recipientName: mail.recipientName,
                subject: mail.mail.subject,
                to: mail.mail.to,
              }
            : null,
          title: deskCard.title,
          toolKey: record?.toolKey ?? null,
          toolName: record?.toolName ?? null,
        };
        return candidate(
          {
            agentId: deskCard.agentId,
            agentName,
            at: deskCard.at,
            expiresAt: record?.expiresAt ?? null,
            id: deskCard.id,
            kind,
            mail: mail?.mail ?? null,
            passedOnBy: passedOn.get(deskCard.runId ?? "") ?? null,
            runId: deskCard.runId ?? null,
            status: plainStatus(facts),
            threadId: mail?.threadId ?? deskCard.threadId ?? null,
            title: plainTitle(facts),
          },
          mail
        );
      }),
      ...sources.stuck.map(({ card, problem }) => {
        const agentName = agentNames.get(card.agentId) ?? card.startedBy;
        const facts = {
          agentName,
          kind: "problem" as const,
          mail: null,
          problem,
          title: card.title,
          toolKey: null,
          toolName: null,
        };
        return candidate(
          {
            agentId: card.agentId,
            agentName,
            at: card.at,
            expiresAt: null,
            id: card.id,
            kind: "problem",
            mail: null,
            passedOnBy: passedOn.get(card.id) ?? null,
            runId: card.id,
            status: plainStatus(facts),
            threadId: null,
            title: plainTitle(facts),
          },
          null
        );
      }),
    ];

    // Rule 7: two or more mail approvals to one outside domain, for one person, become one row.
    const groups = new Map<string, Candidate[]>();
    const rows: Candidate[][] = [];
    for (const entry of candidates) {
      if (entry.groupKey === null) {
        rows.push([entry]);
        continue;
      }
      const key = `${entry.assigneeUserId ?? ""}|${entry.groupKey}`;
      const group = groups.get(key);
      if (group) {
        group.push(entry);
      } else {
        const created = [entry];
        groups.set(key, created);
        rows.push(created);
      }
    }

    const assigneeIds = [
      ...new Set(
        candidates.flatMap(({ assigneeUserId }) => assigneeUserId ?? [])
      ),
    ];
    const names = new Map(directory?.names);
    const unnamed = assigneeIds.filter((userId) => !names.has(userId));
    for (const [userId, label] of await peopleNames(unnamed)) {
      names.set(userId, label);
    }

    const items: RailItem[] = rows.flatMap((group): RailItem[] => {
      const [first] = [...group].sort((a, b) => byCardAge(a.card, b.card));
      if (!first) {
        return [];
      }
      const cards = group.map(({ card }) => card).sort(byCardAge);
      const due = group.flatMap(({ dueAt }) => dueAt ?? []).sort();
      const escalatedToMe = group.some((entry) => entry.escalatedToMe);
      return [
        {
          assigneeName:
            first.assigneeUserId === null
              ? null
              : (names.get(first.assigneeUserId) ?? null),
          assigneeUserId: first.assigneeUserId,
          cards,
          dueAt: due.at(0) ?? null,
          escalatedToMe,
          id: first.card.id,
          mine: mineFor(first.assigneeUserId, escalatedToMe),
        },
      ];
    });

    const inScope = (isMineItem: boolean) => scope === "everyone" || isMineItem;
    const waitingRuns = new Set(sources.waitingRunIds);
    const working: RailWorking[] = sources.running
      .filter((card) => !waitingRuns.has(card.id))
      .map((card) => ({
        agentId: card.agentId,
        agentName: agentNames.get(card.agentId) ?? card.startedBy,
        id: card.id,
        mine: mineFor(assigneeFor(agentOf.get(card.agentId)), false),
        passedOnBy: passedOn.get(card.id) ?? null,
        status: card.band.text,
        title: card.title,
      }))
      .filter(({ mine }) => inScope(mine));

    const doneToday = sources.doneAgentIds.filter((agentId) =>
      inScope(mineFor(assigneeFor(agentOf.get(agentId)), false))
    ).length;

    const setup: RailSetupStep[] = [
      ...(anthropic.configured || Object.values(providers).some(Boolean)
        ? []
        : ["ai_account" as const]),
      ...(agentList.some((agent) => agent.status === "active")
        ? []
        : ["first_agent" as const]),
    ];

    return {
      counts: {
        everyone: items.length,
        mine: items.filter(({ mine }) => mine).length,
      },
      doneToday,
      needsYou: sortNeedsYou(items.filter(({ mine }) => inScope(mine))),
      setup,
      working,
    };
  };

  /** Dismisses a stuck run so it leaves Needs you. Dismissing twice keeps the first. */
  const clearAttention = async (
    principal: Principal,
    runId: string
  ): Promise<void> => {
    const member = requireMember(principal, CLEAR_ACTION);
    const { runId: id } = clearAttentionInputSchema.parse({ runId });
    const [run] = await db
      .select({ id: runRows.id })
      .from(runRows)
      .where(
        and(
          eq(runRows.id, id),
          eq(runRows.workspaceId, member.workspaceId),
          inArray(
            runRows.sessionId,
            db
              .select({ id: sessions.id })
              .from(sessions)
              .where(await visibleSessions(db, member))
          )
        )
      );
    if (!run) {
      throw new ServiceError("not_found", "Task not found");
    }
    await atomic([
      db
        .update(runRows)
        .set({
          attentionClearedAt: clock.now().toISOString(),
          attentionClearedBy: member.userId,
        })
        .where(and(eq(runRows.id, id), isNull(runRows.attentionClearedAt))),
    ]);
  };

  /**
   * One row per agent for the Agents table: what waits on a person, what is
   * running, and the tasks of the last 7 days. Counts follow the desk's
   * visibility rules, like the rail. No per-run cost is stored, so there is none.
   */
  const agentsOverview = async (
    principal: Principal
  ): Promise<AgentOverview[]> => {
    const member = requireMember(principal, READ_ACTION);
    const weekStart = new Date(clock.now().getTime() - WEEK_MS).toISOString();
    const [sources, agentList, weekRows] = await Promise.all([
      desk.railSources(member, { dayStart: weekStart }),
      agents.list(member),
      visibleSessions(db, member).then((visible) =>
        db
          .select({ agentId: runRows.agentId, total: count() })
          .from(runRows)
          .where(
            and(
              eq(runRows.workspaceId, member.workspaceId),
              gte(runRows.createdAt, weekStart),
              inArray(
                runRows.sessionId,
                db.select({ id: sessions.id }).from(sessions).where(visible)
              )
            )
          )
          .groupBy(runRows.agentId)
      ),
    ]);
    const tally = (ids: readonly string[]) => {
      const counts = new Map<string, number>();
      for (const id of ids) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      return counts;
    };
    const waiting = tally(sources.needsYou.map((card) => card.agentId));
    const waitingRuns = new Set(sources.waitingRunIds);
    const working = tally(
      sources.running
        .filter((card) => !waitingRuns.has(card.id))
        .map((card) => card.agentId)
    );
    const week = new Map(weekRows.map((row) => [row.agentId, row.total]));
    return agentList.map((agent) => ({
      agentId: agent.id,
      tasksThisWeek: week.get(agent.id) ?? 0,
      waiting: waiting.get(agent.id) ?? 0,
      working: working.get(agent.id) ?? 0,
    }));
  };

  return { agentsOverview, clearAttention, get };
};

export type RailService = ReturnType<typeof createRailService>;
