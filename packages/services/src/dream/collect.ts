import type { Database } from "@repo/db";
import { events as eventRows } from "@repo/db/schema/events";
import { memoryChanges } from "@repo/db/schema/memory";
import { runRequests } from "@repo/db/schema/requests";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { skillVersions } from "@repo/db/schema/skills";
import { and, eq, sql } from "drizzle-orm";
import { findAgent } from "../agents.ts";
import { authorize } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import {
  EVENT_QUERY_MAX_LIMIT,
  type EventRecord,
  type EventsService,
} from "../events.ts";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";

export const DEFAULT_DREAM_CHARACTER_BUDGET = 100_000;

export type DreamInputKind =
  | "message"
  | "task_result"
  | "request"
  | "edit_resend"
  | "failed_run"
  | "interrupted_run"
  | "memory_change"
  | "memory_proposal"
  | "skill_proposal";

/** Private belongs to userId; outside is untrusted mail/peer/guest evidence;
 * workspace is other evidence from the workspace. Outside takes precedence
 * over session privacy for an outside actor's text, with userId retained. */
export type DreamInputScope = "private" | "outside" | "workspace";

export interface DreamInput {
  createdAt: string;
  denied?: boolean;
  /** Unique evidence id (messages use their event id). */
  id: string;
  kind: DreamInputKind;
  scope: DreamInputScope;
  sourceId: string;
  sourceKind:
    | "session"
    | "run"
    | "request"
    | "memory_change"
    | "skill_proposal";
  text: string;
  truncated?: boolean;
  userId?: string;
}

export interface DreamCollection {
  /** Oldest first, with a deterministic id tie break. */
  items: DreamInput[];
  leftOut: {
    byKind: Partial<Record<DreamInputKind, number>>;
    characters: number;
    /** Fully omitted items; partially retained items count under truncated. */
    total: number;
    truncated: number;
  };
}

export interface DreamCollectOptions {
  /** Counts text characters (UTF-16 code units), excluding provenance metadata. */
  characterBudget?: number;
}

type Tags = Pick<DreamInput, "scope" | "userId">;
type Session = typeof sessions.$inferSelect;
type Run = typeof runs.$inferSelect;
const isResend = (
  prior: EventRecord | undefined,
  priorRun: Run | undefined,
  event: EventRecord
) =>
  prior &&
  priorRun?.status === "cancelled" &&
  priorRun.finishedAt &&
  priorRun.finishedAt <= event.createdAt &&
  prior.runId !== event.runId;

const tagsFor = (session?: Session, actorKind?: string): Tags => {
  const userId =
    session &&
    (session.private || session.origin === "ui") &&
    session.actorKind === "user"
      ? session.actorId
      : undefined;
  const outside =
    ["peer", "guest", "mail", "external"].includes(actorKind ?? "") ||
    ["mail", "a2a"].includes(session?.origin ?? "");
  const localScope = userId || session?.private ? "private" : "workspace";
  return {
    scope: outside ? "outside" : localScope,
    ...(userId ? { userId } : {}),
  };
};

const compare = (a: DreamInput, b: DreamInput) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

const cap = (items: DreamInput[], budget: number): DreamCollection => {
  const kept: DreamInput[] = [];
  const leftOut: DreamCollection["leftOut"] = {
    byKind: {},
    characters: 0,
    total: 0,
    truncated: 0,
  };
  let remaining = budget;
  for (const item of items.sort(compare).reverse()) {
    if (remaining === 0) {
      leftOut.total += 1;
      leftOut.byKind[item.kind] = (leftOut.byKind[item.kind] ?? 0) + 1;
      leftOut.characters += item.text.length;
    } else if (item.text.length > remaining) {
      // Keep a strict newest-first prefix, including the last partial item.
      kept.push({
        ...item,
        text: item.text.slice(0, remaining),
        truncated: true,
      });
      leftOut.characters += item.text.length - remaining;
      leftOut.truncated += 1;
      remaining = 0;
    } else {
      kept.push(item);
      remaining -= item.text.length;
    }
  }
  return { items: kept.sort(compare), leftOut };
};

/** Internal system collector for DR.4; since is exclusive, null reads the first
 * dream's full history. Never-remember filtering belongs to the later steps. */
export const createDreamCollector = ({
  db,
  events,
}: {
  db: Database;
  events: Pick<EventsService, "query" | "readPayload">;
}) => {
  const collectSince = async (
    agentId: string,
    since: string | null,
    options: DreamCollectOptions = {}
  ): Promise<DreamCollection> => {
    const budget = options.characterBudget ?? DEFAULT_DREAM_CHARACTER_BUDGET;
    if (
      !Number.isSafeInteger(budget) ||
      budget < 0 ||
      (since !== null && !Number.isFinite(Date.parse(since)))
    ) {
      throw new ServiceError(
        "invalid",
        "Invalid dream window or character budget"
      );
    }
    // Bootstrap by globally unique agent id: system has no workspace. Every
    // subsequent read is scoped to this row's workspace AND this agent.
    const agent = await findAgent(db, { id: agentId });
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    const { workspaceId } = agent;
    authorize(SYSTEM_PRINCIPAL, "dream.read", {
      id: agentId,
      kind: "dream",
      workspaceId,
    });
    // Session/memory/skill listing services reject system through their reader
    // guards; requests has no historical list. Read their rows in this workspace
    // directly instead of impersonating a person (which would hide private data).
    const [sessionRows, runRows, requests, changes, rejected] =
      await Promise.all([
        db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.workspaceId, workspaceId),
              eq(sessions.agentId, agentId)
            )
          ),
        db
          .select()
          .from(runs)
          .where(
            and(eq(runs.workspaceId, workspaceId), eq(runs.agentId, agentId))
          ),
        db
          .select()
          .from(runRequests)
          .where(
            and(
              eq(runRequests.workspaceId, workspaceId),
              eq(runRequests.agentId, agentId)
            )
          ),
        db
          .select()
          .from(memoryChanges)
          .where(
            and(
              eq(memoryChanges.workspaceId, workspaceId),
              eq(memoryChanges.agentId, agentId)
            )
          ),
        // Human rejection events may have no agentId. Attribute them by the
        // version's author, including proposals to shared/another agent's skills.
        // EventsService.query cannot express this join. The event supplies the
        // rejection time; version.createdAt is the proposal time, not the decision.
        db
          .select({ event: eventRows, version: skillVersions })
          .from(skillVersions)
          .innerJoin(
            eventRows,
            and(
              eq(eventRows.workspaceId, workspaceId),
              eq(eventRows.type, "skill.rejected"),
              sql`json_extract(${eventRows.payload}, '$.skillId') = ${skillVersions.skillId}`,
              sql`json_extract(${eventRows.payload}, '$.version') = ${skillVersions.number}`
            )
          )
          .where(
            and(
              eq(skillVersions.workspaceId, workspaceId),
              eq(skillVersions.authorKind, "agent"),
              eq(skillVersions.authorId, agentId),
              eq(skillVersions.status, "rejected")
            )
          ),
      ]);
    const bySession = new Map(sessionRows.map((row) => [row.id, row]));
    // Refuse inconsistent cross-agent session links even within one workspace.
    const byRun = new Map(
      runRows
        .filter((row) => bySession.has(row.sessionId))
        .map((row) => [row.id, row])
    );
    const byRequest = new Map(
      requests
        .filter((row) => bySession.has(row.sessionId) && byRun.has(row.runId))
        .map((row) => [row.id, row])
    );
    const runTags = (runId: string | null): Tags => {
      const run = runId ? byRun.get(runId) : undefined;
      return tagsFor(
        run ? bySession.get(run.sessionId) : undefined,
        run?.actorKind
      );
    };
    const sourceTags = (kind: string | null, id: string | null): Tags => {
      if (kind === "session") {
        return tagsFor(id ? bySession.get(id) : undefined);
      }
      if (kind === "request") {
        return runTags(id ? (byRequest.get(id)?.runId ?? null) : null);
      }
      return runTags(id);
    };
    const items: DreamInput[] = [];
    const fresh = (time: string) =>
      since === null || Date.parse(time) > Date.parse(since);
    const add = (item: DreamInput) => {
      if (fresh(item.createdAt)) {
        items.push(item);
      }
    };
    const readMessages = async () => {
      const messages: EventRecord[] = [];
      let after: string | undefined;
      // Read all message history to recover the original of a resend even when
      // it precedes since. Page explicitly: the service defaults to only 100 rows.
      for (;;) {
        // biome-ignore lint/performance/noAwaitInLoops: cursor depends on the previous page
        const page = await events.query(SYSTEM_PRINCIPAL, workspaceId, {
          after,
          agentId,
          limit: EVENT_QUERY_MAX_LIMIT,
          types: ["message.user", "message.assistant"],
        });
        messages.push(
          ...page.filter(
            (event) =>
              event.sessionId &&
              bySession.has(event.sessionId) &&
              (!event.runId || byRun.has(event.runId))
          )
        );
        if (page.length < EVENT_QUERY_MAX_LIMIT) {
          break;
        }
        after = page.at(-1)?.id;
      }
      return messages;
    };
    const previous = new Map<string, { event: EventRecord; text: string }>();
    const collectResend = (
      event: EventRecord,
      text: string,
      tags: Tags,
      sessionId: string
    ) => {
      if (event.type !== "message.user" || event.actor.kind !== "user") {
        return;
      }
      const key = `${sessionId}:${event.actor.id}`;
      const prior = previous.get(key);
      const priorRun = prior?.event.runId
        ? byRun.get(prior.event.runId)
        : undefined;
      // No persistent edit event exists: thread/edited-marks.ts stores marks in
      // sessionStorage. Conservatively infer a resend from the same person's
      // next user message after a cancelled run in the same session. This is a
      // signal, not proof of an edit; edits of completed runs cannot be known.
      if (prior && priorRun && isResend(prior.event, priorRun, event)) {
        add({
          ...tags,
          createdAt: event.createdAt,
          id: `resend:${event.id}`,
          kind: "edit_resend",
          sourceId: sessionId,
          sourceKind: "session",
          text: `Inferred resend after cancelled run ${priorRun.id}. Original (${prior.event.id}): ${prior.text}\nResent (${event.id}): ${text}`,
        });
      }
      previous.set(key, { event, text });
    };
    const collectMessages = async () => {
      const messages = await readMessages();
      messages.sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
      );

      for (const event of messages) {
        // biome-ignore lint/performance/noAwaitInLoops: preserve message order for resend inference
        const payload = await events.readPayload(SYSTEM_PRINCIPAL, event);
        const text =
          typeof payload.text === "string"
            ? payload.text
            : JSON.stringify(payload);
        const sessionId = event.sessionId ?? "";
        const tags = tagsFor(bySession.get(sessionId), event.actor.kind);
        add({
          ...tags,
          createdAt: event.createdAt,
          id: event.id,
          kind: "message",
          sourceId: sessionId,
          sourceKind: "session",
          text,
        });
        collectResend(event, text, tags, sessionId);
      }
    };
    const collectResult = (run: Run) => {
      if (!run.finishedAt) {
        return;
      }
      const base = {
        ...runTags(run.id),
        createdAt: run.finishedAt,
        id: run.id,
        sourceId: run.id,
        sourceKind: "run" as const,
      };
      if (run.status === "failed" || run.status === "interrupted") {
        add({
          ...base,
          kind: run.status === "failed" ? "failed_run" : "interrupted_run",
          text: JSON.stringify({
            error: run.error,
            input: run.inputText,
            result: run.resultText,
            status: run.status,
          }),
        });
      } else if (run.status === "done" && run.resultText) {
        add({ ...base, kind: "task_result", text: run.resultText });
      }
    };
    const collectRequests = () => {
      for (const request of byRequest.values()) {
        const answer = request.answer ? JSON.parse(request.answer) : null;
        add({
          ...runTags(request.runId),
          createdAt: request.answeredAt ?? request.createdAt,
          denied: request.kind === "approval" && answer?.decision === "deny",
          id: request.id,
          kind: "request",
          sourceId: request.id,
          sourceKind: "request",
          text: JSON.stringify({
            answer,
            display: JSON.parse(request.display),
            kind: request.kind,
            status: request.status,
            toolName: request.toolName,
          }),
        });
      }
    };
    const collectChange = (change: typeof memoryChanges.$inferSelect) => {
      if (
        change.writtenBy === "dream" ||
        (change.writtenBy !== "agent" && change.status !== "rejected")
      ) {
        return;
      }
      add({
        ...(change.userScope
          ? { scope: "private" as const, userId: change.userScope }
          : sourceTags(change.sourceKind, change.sourceId)),
        createdAt:
          change.status === "rejected"
            ? (change.decidedAt ?? change.createdAt)
            : change.createdAt,
        id: change.id,
        kind:
          change.status === "rejected" ? "memory_proposal" : "memory_change",
        sourceId: change.id,
        sourceKind: "memory_change",
        text: JSON.stringify({
          action: change.action,
          kind: change.kind,
          sourceId: change.sourceId,
          sourceKind: change.sourceKind,
          status: change.status,
          text: change.text,
        }),
      });
    };
    const collectRejections = () => {
      for (const { version, event } of rejected) {
        add({
          ...runTags(version.authorRunId),
          createdAt: event.createdAt,
          id: version.id,
          kind: "skill_proposal",
          sourceId: version.id,
          sourceKind: "skill_proposal",
          text: JSON.stringify({
            message: version.message,
            skillId: version.skillId,
            status: version.status,
            version: version.number,
          }),
        });
      }
    };
    await collectMessages();
    for (const run of byRun.values()) {
      collectResult(run);
    }
    collectRequests();
    for (const change of changes) {
      collectChange(change);
    }
    collectRejections();
    return cap(items, budget);
  };
  return { collectSince };
};
