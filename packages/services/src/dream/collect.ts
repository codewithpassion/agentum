import type { Database } from "@repo/db";
import { events as eventRows } from "@repo/db/schema/events";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { findAgent } from "../agents.ts";
import { authorize } from "../authz.ts";
import { ServiceError } from "../errors.ts";
import { type EventRecord, type EventsService, toRecord } from "../events.ts";
import { outsideSourceOf } from "../memory/guards.ts";
import { peerRootOf } from "../runs/peer-root.ts";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";
import {
  type Context,
  loadContext,
  type MemoryChange,
  type Run,
  readWindow,
  type Scope,
  type Session,
  type Window,
} from "./collect-load.ts";

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

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** A mail reply runs as the mailbox's trigger, even inside an existing session. */
const MAIL_ACTOR_PREFIX = "mail:";
const isMailActor = (kind: string | null | undefined, id: string | null) =>
  kind === "trigger" && (id?.startsWith(MAIL_ACTOR_PREFIX) ?? false);

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

/**
 * Outside text is mail, an A2A peer, a guest, or anything that reached the run
 * through such a source (a peer anywhere up the run's parent chain). It shares
 * `outsideSourceOf` with the memory service so both read one rule.
 */
const tagsFor = (
  session: Session | undefined,
  actor: { id: string | null; kind: string | null },
  peerRooted: boolean
): Tags => {
  const userId =
    session &&
    (session.private || session.origin === "ui") &&
    session.actorKind === "user"
      ? session.actorId
      : undefined;
  const outside =
    outsideSourceOf({
      origin: session?.origin ?? null,
      peer: peerRooted || actor.kind === "peer",
      web: false,
    }) !== null ||
    actor.kind === "guest" ||
    isMailActor(actor.kind, actor.id) ||
    isMailActor(session?.actorKind, session?.actorId ?? null);
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

interface Deps {
  db: Database;
  events: Pick<EventsService, "readPayload">;
}

/** Everything one collection reads and writes. */
interface Collection extends Context, Scope, Deps {
  add: (item: DreamInput) => void;
  peerCache: Map<string, boolean>;
  window: Window;
}

// A dry run only pretends to act. Its text is not evidence of anything.
const isLive = (
  { runById, sessionById }: Collection,
  sessionId: string | null,
  runId: string | null
) => {
  const session = sessionId ? sessionById.get(sessionId) : undefined;
  const run = runId ? runById.get(runId) : undefined;
  return (
    session !== undefined &&
    session.origin !== "dry_run" &&
    (!runId || (run !== undefined && !run.dryRun))
  );
};

const isPeerRooted = async (c: Collection, run: Run | undefined) => {
  if (!run) {
    return false;
  }
  const cached = c.peerCache.get(run.id);
  if (cached !== undefined) {
    return cached;
  }
  const root = await peerRootOf(c.db, {
    // peerRootOf only asks whether the actor is a peer.
    actor: { id: run.actorId, kind: run.actorKind === "peer" ? "peer" : "run" },
    parentRunId: run.parentRunId,
    workspaceId: c.workspaceId,
  });
  c.peerCache.set(run.id, root !== null);
  return root !== null;
};

const runTags = async (c: Collection, runId: string | null): Promise<Tags> => {
  const run = runId ? c.runById.get(runId) : undefined;
  return tagsFor(
    run ? c.sessionById.get(run.sessionId) : undefined,
    { id: run?.actorId ?? null, kind: run?.actorKind ?? null },
    await isPeerRooted(c, run)
  );
};

const sourceTags = (
  c: Collection,
  kind: string | null,
  id: string | null
): Promise<Tags> => {
  if (kind === "session") {
    const session = id ? c.sessionById.get(id) : undefined;
    return Promise.resolve(tagsFor(session, { id: null, kind: null }, false));
  }
  if (kind === "request") {
    return runTags(c, id ? (c.requestById.get(id)?.runId ?? null) : null);
  }
  return runTags(c, id);
};

const textOf = async (c: Collection, event: EventRecord) => {
  const payload = await c.events.readPayload(SYSTEM_PRINCIPAL, event);
  return typeof payload.text === "string"
    ? payload.text
    : JSON.stringify(payload);
};

const priorUserMessage = async (c: Collection, event: EventRecord) => {
  const [row] = await c.db
    .select()
    .from(eventRows)
    .where(
      and(
        eq(eventRows.workspaceId, c.workspaceId),
        eq(eventRows.agentId, c.agentId),
        eq(eventRows.sessionId, event.sessionId ?? ""),
        eq(eventRows.type, "message.user"),
        eq(eventRows.actorId, event.actor.id),
        or(
          lt(eventRows.createdAt, event.createdAt),
          and(
            eq(eventRows.createdAt, event.createdAt),
            lt(eventRows.id, event.id)
          )
        )
      )
    )
    .orderBy(desc(eventRows.createdAt), desc(eventRows.id))
    .limit(1);
  return row ? toRecord(row) : undefined;
};

const hasCancelledRun = (c: Collection, sessionId: string) =>
  [...c.runById.values()].some(
    (run) => run.sessionId === sessionId && run.status === "cancelled"
  );

// No persistent edit event exists: thread/edited-marks.ts stores marks in
// sessionStorage. Conservatively infer a resend from the same person's next
// user message after a cancelled run in the same session. This is a signal,
// not proof of an edit; edits of completed runs cannot be known.
const collectResend = async (
  c: Collection,
  event: EventRecord,
  text: string,
  tags: Tags,
  sessionId: string
) => {
  if (
    event.type !== "message.user" ||
    event.actor.kind !== "user" ||
    !hasCancelledRun(c, sessionId)
  ) {
    return;
  }
  const prior = await priorUserMessage(c, event);
  const priorRun = prior?.runId ? c.runById.get(prior.runId) : undefined;
  if (
    !(prior && priorRun && isResend(prior, priorRun, event)) ||
    priorRun.dryRun
  ) {
    return;
  }
  c.add({
    ...tags,
    createdAt: event.createdAt,
    id: `resend:${event.id}`,
    kind: "edit_resend",
    sourceId: sessionId,
    sourceKind: "session",
    text: `Inferred resend after cancelled run ${priorRun.id}. Original (${prior.id}): ${await textOf(c, prior)}\nResent (${event.id}): ${text}`,
  });
};

const collectMessages = async (c: Collection) => {
  const records = c.window.messageRows
    .map(toRecord)
    .filter(
      (event) =>
        event.sessionId &&
        isLive(c, event.sessionId, event.runId) &&
        (!event.runId || c.runById.has(event.runId))
    )
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
    );
  for (const event of records) {
    const sessionId = event.sessionId ?? "";
    // biome-ignore lint/performance/noAwaitInLoops: one payload read per message, in order
    const text = await textOf(c, event);
    const run = event.runId ? c.runById.get(event.runId) : undefined;
    const own = tagsFor(
      c.sessionById.get(sessionId),
      event.actor,
      await isPeerRooted(c, run)
    );
    // The run's own actor counts too: an assistant message of a mail-reply
    // run has the agent as its actor, but the run was started by outside mail.
    const tags: Tags =
      own.scope !== "outside" &&
      (await runTags(c, event.runId)).scope === "outside"
        ? { ...own, scope: "outside" }
        : own;
    c.add({
      ...tags,
      createdAt: event.createdAt,
      id: event.id,
      kind: "message",
      sourceId: sessionId,
      sourceKind: "session",
      text,
    });
    await collectResend(c, event, text, tags, sessionId);
  }
};

const collectResult = async (c: Collection, run: Run) => {
  if (!(run.finishedAt && isLive(c, run.sessionId, run.id))) {
    return;
  }
  const base = {
    ...(await runTags(c, run.id)),
    createdAt: run.finishedAt,
    id: run.id,
    sourceId: run.id,
    sourceKind: "run" as const,
  };
  if (run.status === "failed" || run.status === "interrupted") {
    c.add({
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
    c.add({ ...base, kind: "task_result", text: run.resultText });
  }
};

const decisionOf = (answer: unknown) =>
  typeof answer === "object" && answer !== null && "decision" in answer
    ? answer.decision
    : undefined;

const collectRequests = async (c: Collection) => {
  for (const request of c.window.windowRequests) {
    if (!isLive(c, request.sessionId, request.runId)) {
      continue;
    }
    const answer = request.answer ? safeJson(request.answer) : null;
    // biome-ignore lint/performance/noAwaitInLoops: tags are cached per run
    const tags = await runTags(c, request.runId);
    c.add({
      ...tags,
      createdAt: request.answeredAt ?? request.createdAt,
      denied: request.kind === "approval" && decisionOf(answer) === "deny",
      id: request.id,
      kind: "request",
      sourceId: request.id,
      sourceKind: "request",
      text: JSON.stringify({
        answer,
        display: safeJson(request.display),
        kind: request.kind,
        status: request.status,
        toolName: request.toolName,
      }),
    });
  }
};

const collectChange = async (c: Collection, change: MemoryChange) => {
  const rejectedChange = change.status === "rejected";
  if (
    change.writtenBy === "dream" ||
    (change.writtenBy !== "agent" && !rejectedChange)
  ) {
    return;
  }
  const source = await sourceTags(c, change.sourceKind, change.sourceId);
  // Outside takes precedence over privacy: the text stays held for approval.
  const tags: Tags = change.userScope
    ? {
        scope: source.scope === "outside" ? "outside" : "private",
        userId: change.userScope,
      }
    : source;
  c.add({
    ...tags,
    createdAt: rejectedChange
      ? (change.decidedAt ?? change.createdAt)
      : change.createdAt,
    id: change.id,
    kind: rejectedChange ? "memory_proposal" : "memory_change",
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

const collectRejections = async (c: Collection) => {
  // A version rejected twice has two events; keep the newest per version.
  const newest = new Map<string, Window["rejected"][number]>();
  for (const row of c.window.rejected) {
    const known = newest.get(row.version.id);
    if (!known || known.event.createdAt < row.event.createdAt) {
      newest.set(row.version.id, row);
    }
  }
  for (const { version, event } of newest.values()) {
    const authorRun = version.authorRunId
      ? c.runById.get(version.authorRunId)
      : undefined;
    if (authorRun?.dryRun) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: tags are cached per run
    const tags = await runTags(c, version.authorRunId);
    c.add({
      ...tags,
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

const validWindow = (since: string | null, budget: number) =>
  Number.isSafeInteger(budget) &&
  budget >= 0 &&
  (since === null || Number.isFinite(Date.parse(since)));

/** Internal system collector for DR.4; since is exclusive, null reads the first
 * dream's full history. Never-remember filtering belongs to the later steps. */
export const createDreamCollector = (deps: Deps) => {
  const collectSince = async (
    agentId: string,
    since: string | null,
    options: DreamCollectOptions = {}
  ): Promise<DreamCollection> => {
    const budget = options.characterBudget ?? DEFAULT_DREAM_CHARACTER_BUDGET;
    if (!validWindow(since, budget)) {
      throw new ServiceError(
        "invalid",
        "Invalid dream window or character budget"
      );
    }
    // Bootstrap by globally unique agent id: system has no workspace. Every
    // subsequent read is scoped to this row's workspace AND this agent.
    const agent = await findAgent(deps.db, { id: agentId });
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    const { workspaceId } = agent;
    authorize(SYSTEM_PRINCIPAL, "dream.read", {
      id: agentId,
      kind: "dream",
      workspaceId,
    });
    // The session, memory and skill services reject the system principal and
    // requests has no historical list, so the rows are read directly in this
    // workspace instead of impersonating a person (which would hide private data).
    const floor = since === null ? null : new Date(since).toISOString();
    const scope: Scope = { agentId, floor, workspaceId };
    const window = await readWindow(deps.db, scope);
    const context = await loadContext(deps.db, scope, window);
    const items: DreamInput[] = [];
    const c: Collection = {
      ...deps,
      ...context,
      ...scope,
      add: (item) => {
        if (floor === null || item.createdAt > floor) {
          items.push(item);
        }
      },
      peerCache: new Map(),
      window,
    };
    await collectMessages(c);
    for (const run of window.finishedRuns) {
      // biome-ignore lint/performance/noAwaitInLoops: tags are cached per run
      await collectResult(c, run);
    }
    await collectRequests(c);
    for (const change of window.changes) {
      // biome-ignore lint/performance/noAwaitInLoops: tags are cached per run
      await collectChange(c, change);
    }
    await collectRejections(c);
    return cap(items, budget);
  };
  return { collectSince };
};
