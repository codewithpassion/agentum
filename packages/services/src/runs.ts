/**
 * Runs (contracts C3 and C7). Every way to make an agent do something goes
 * through `startRun`: it derives who is asking from the principal, finds or
 * creates the session, inserts a queued run and hands it to the agent's
 * runtime adapter. `ingestRunEvents` and `completeRun` are what the runtime
 * calls back with, fenced so that only a `running` or `waiting` run accepts them. The types
 * (adapters, gateways, the input schema) are in `@repo/services/runs/types`.
 */
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { agents as agentRows } from "@repo/db/schema/agents";
import { events } from "@repo/db/schema/events";
import { guestRunScopes } from "@repo/db/schema/live-artifacts";
import { machines } from "@repo/db/schema/machines";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { type AgentRuntime, taskFolderPath } from "@repo/db/shared";
import { type GuestGrant, guestGrantSchema } from "@repo/protocol/live";
import {
  FEATURE_PARALLEL_SUBAGENTS,
  hasDaemonFeature,
} from "@repo/protocol/machine";
import type { Masker } from "@repo/protocol/masker";
import {
  REPEAT_STOP_AT,
  type RunStop,
  runStopSchema,
  stopMessage,
  streakOf,
  type ToolOutcome,
} from "@repo/protocol/safeguards";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { monotonicFactory, ulid } from "ulidx";
import { z } from "zod";
import { assertModelForRuntime, findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { cloudEnvironmentOf } from "./cloud/environment.ts";
import { CLOUD_LEASE_MS } from "./cloud/lease.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
import { payloadSchema } from "./events/payload.ts";
import {
  type Blobs,
  createEventsService,
  type PeopleLookup,
} from "./events.ts";
import type { LibraryService } from "./library.ts";
import { MANAGED_LEASE_MS } from "./managed/types.ts";
import {
  importRunTokenKey,
  type RunTokenClaims,
  signRunToken,
} from "./run-tokens.ts";
import { validateSubagentAccess } from "./runs/access-scope.ts";
import { authorizeArtifactRun } from "./runs/artifact-access.ts";
import { createFakeRuntime } from "./runs/fake-runtime.ts";
import { noneGateway } from "./runs/gateways.ts";
import {
  authenticateGuestRun,
  currentGuestRun,
  guestStartGuard,
  guestUnavailable,
  isGuestStartGuardFailure,
} from "./runs/guest-scope.ts";
import { claimForMachine } from "./runs/machine-claim.ts";
import { peerRootOf } from "./runs/peer-root.ts";
import {
  findSession,
  findSessionById,
  loadRun,
  loadRunByRequest,
  requireFiles,
} from "./runs/queries.ts";
import { type RunRow, toRecord, toSummary } from "./runs/records.ts";
import {
  type Actor,
  deriveSubject,
  eventActor,
  MAX_RUN_DEPTH,
  START_ACTION,
  type Subject,
} from "./runs/subject.ts";
import {
  type AdapterDeps,
  type Clock,
  type Gateway,
  type MachineClaim,
  RUN_EVENT_TYPES,
  type RunEventInput,
  type RunRecord,
  type RunResult,
  type RunSummary,
  type RuntimeAdapter,
  type StartRunInput,
  type StartRunOptions,
  startRunInputSchema,
  TERMINAL_STATUSES,
  usageSchema,
} from "./runs/types.ts";
import type { SecretsService } from "./secrets.ts";
import { visibleSessions } from "./sessions.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

/** A claimed run is `running` until this long after the last heartbeat. */
export const LEASE_MS = 90_000;
/** A run still `queued` or `offered` after this long is offered again. */
export const STALE_QUEUE_MS = 60_000;
/**
 * A run still `queued` or `offered` after this long is failed, counted from
 * `created_at` or from when its agent was last free, whichever is later. An
 * agent is not free while one of its runs is `running` or `waiting`.
 */
export const UNCLAIMED_EXPIRY_MS = 60 * 60_000;
const NEVER_CLAIMED_ERROR = "Never claimed";
export const WAIT_MAX_MS = 120_000;
const WAIT_POLL_MS = 500;
/** Rows one tick job handles; the next minute takes the rest. */
const SWEEP_BATCH = 100;
/** Failed downloads of a run's pending files before the run is failed. */
export const MAX_PENDING_ATTEMPTS = 3;
const PENDING_FILES_ERROR = "Could not download the attached files";
/** One download of a run's pending files at a time; a lost holder frees it after this. */
const DOWNLOAD_LEASE_MS = 5 * 60_000;
/** The `message.user` event of a run started with `offerLater` keeps this much of the text. */
const EVENT_TEXT_CHARS = 20_000;
/** The most recent tool events a batch's repeat check reads: about ten call and result pairs. */
const RECENT_TOOL_EVENTS = 20;

/** Run ids rise within one millisecond, so the id tie-break of the start order is the creation order. */
const nextRunId = monotonicFactory();

/**
 * `main:<userId>` is a person's main thread, made by `sessions.main`. Only
 * that user may open a `ui` session under the key, so nobody can take it first.
 */
const requireOwnMainKey = (
  actor: { id: string; kind: string },
  input: ParsedInput
): void => {
  const key = input.session.externalKey;
  if (
    input.session.origin === "ui" &&
    key?.startsWith("main:") &&
    !(actor.kind === "user" && key === `main:${actor.id}`)
  ) {
    throw new ForbiddenError(START_ACTION);
  }
};

/** The session of a run, as a subquery, for a session that run starts. */
const parentSessionOf = (parentRunId: string | null) =>
  parentRunId === null
    ? null
    : sql<
        string | null
      >`(select session_id from runs where id = ${parentRunId})`;

const STARTING: RunRecord["status"][] = ["queued", "offered"];
/** A claimed run: working, or waiting for a person's answer. */
const LIVE: RunRecord["status"][] = ["running", "waiting"];
const ACTIVE: RunRecord["status"][] = ["queued", "offered", ...LIVE];

/** A lease longer than the machine default, by the agent runtime that needs it. */
const RUNTIME_LEASE_MS: Partial<Record<AgentRuntime, number>> = {
  cloud: CLOUD_LEASE_MS,
  managed: MANAGED_LEASE_MS,
};

const READ_ACTION = "runs.read";
const RUN_KIND = "run";

/** Longest summary of a skipped call, in characters. */
const DRY_RUN_SUMMARY_MAX = 200;

const dryRunSkipSchema = z.strictObject({
  summary: z.string(),
  tool: z.string().min(1).max(200),
});

const runResultSchema = z.strictObject({
  error: z.string().max(10_000).optional(),
  fileIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  runtimeRef: z.string().min(1).max(500).optional(),
  status: z.enum(["done", "failed", "aborted"]),
  stop: runStopSchema.optional(),
  text: z.string().max(1_000_000).optional(),
  usage: usageSchema.optional(),
});

type RunResultInput = z.infer<typeof runResultSchema>;

/** The error a failed run stores: the safeguard's line when it stopped, else the runtime's. */
const failureError = (result: RunResultInput): string =>
  result.stop ? stopMessage(result.stop) : (result.error ?? "Run failed");

/** The event a safeguard stop records before `run.failed`, with its error line. */
const stopEvent = (
  stop: RunStop
): {
  payload: Record<string, unknown>;
  type: "run.limit_reached" | "run.repeat_stopped";
} => {
  const error = stopMessage(stop);
  return stop.kind === "turn_limit"
    ? { payload: { error, limit: stop.limit }, type: "run.limit_reached" }
    : {
        payload: { count: stop.count, error, tool: stop.tool },
        type: "run.repeat_stopped",
      };
};

const toolCallSchema = z.object({
  input: z.unknown(),
  name: z.string(),
  toolUseId: z.string(),
});
const toolResultSchema = z.object({
  ok: z.unknown(),
  toolUseId: z.string(),
});

const parseJson = (raw: string | null): unknown => {
  if (raw === null) {
    return;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A row that is not JSON is ignored by the caller.
  }
};

/**
 * The outcomes of the tool calls and results in ascending order. A result pairs
 * with the call that has its `toolUseId`; a result without one is skipped, and so
 * is a row that does not parse. Only `ok: false` counts as a failure.
 */
const toolOutcomes = (
  rows: readonly { payload: string | null; type: string }[]
): ToolOutcome[] => {
  const calls = new Map<string, z.infer<typeof toolCallSchema>>();
  const outcomes: ToolOutcome[] = [];
  for (const row of rows) {
    const payload = parseJson(row.payload);
    if (row.type === "tool.call") {
      const call = toolCallSchema.safeParse(payload);
      if (call.success) {
        calls.set(call.data.toolUseId, call.data);
      }
      continue;
    }
    const result = toolResultSchema.safeParse(payload);
    if (!result.success) {
      continue;
    }
    const call = calls.get(result.data.toolUseId);
    if (call) {
      outcomes.push({
        input: call.input,
        name: call.name,
        ok: result.data.ok !== false,
      });
    }
  }
  return outcomes;
};

/** `result` with the granted secret values taken out of its text and error. */
const maskResult = (
  result: RunResultInput,
  masker: Masker | null
): RunResultInput =>
  masker
    ? {
        ...result,
        ...(result.error === undefined
          ? {}
          : { error: masker.mask(result.error) }),
        ...(result.text === undefined
          ? {}
          : { text: masker.mask(result.text) }),
      }
    : result;

const runEventsSchema = z
  .array(
    z.strictObject({
      payload: payloadSchema,
      seq: z.number().int().min(1),
      type: z.enum(RUN_EVENT_TYPES),
    })
  )
  .max(500);

const assertArtifactReply = (input: z.output<typeof startRunInputSchema>) => {
  if (input.session.origin === "artifact" && input.reply.kind !== "none") {
    throw new ForbiddenError("runs.artifactOutboundReply");
  }
};

export interface RunsServiceOptions {
  adapters: readonly RuntimeAdapter[];
  atomic: Atomic;
  /** Trusted selected-agent policy. Session/grant checks and atomic cap are enforced internally.
   * Must not charge: retries call this policy again. */
  authorizeGuestGrant?: (
    grant: GuestGrant,
    input: { agentId: string; artifactId: string; workspaceId: string }
  ) => Promise<void>;
  blobs: Blobs;
  clock: Clock;
  db: Database;
  /** Registers the echo runtime for agents whose runtime is `fake`. */
  devFakeRuntime: boolean;
  gateways: readonly Gateway[];
  /** Separate bounded executor; never replaces the ordinary member adapter.
   * Production admission still requires guestRuntimeReady and current policy. */
  guestAdapter?: RuntimeAdapter;
  /** Only enable runtimes enforcing scoped tools, service checks and owner approval routing. */
  guestRuntimeReady?: (runtime: string) => boolean;
  /** Emergency switch read at every scoped operation; absent means off. */
  guestsOff?: () => boolean;
  /**
   * The workspace library. A machine claim lists the conflict copies waiting
   * for the agent, and each new run gets its task folder. Without it, the claim
   * names no library paths and runs get no folder.
   */
  library?: Pick<LibraryService, "mkdir" | "pendingConflicts">;
  people?: PeopleLookup;
  /**
   * `RUN_TOKEN_KEY` (base64, 32 bytes). Only the machine claim needs it, which
   * mints the run token; leave it out where no machine claims runs.
   */
  runTokenKey?: string;
  /**
   * The workspace secrets store. A machine claim hands the agent its secrets,
   * and everything a run writes to its transcript or result goes through the
   * agent's masker, so a granted value never lands in an event, a result or a
   * reply. Without it, no secret is delivered or masked.
   */
  secrets?: Pick<
    SecretsService,
    "announceDelivery" | "maskerFor" | "resolveForAgent"
  >;
}

type ParsedInput = ReturnType<typeof startRunInputSchema.parse>;

const artifactSelectionPatch = (
  session: typeof sessions.$inferSelect,
  agentId: string
) => {
  if (session.origin !== "artifact") {
    return {};
  }
  return {
    agentId,
    ...(session.agentId === agentId
      ? {}
      : { runtimeMachineId: null, runtimeRef: null }),
  };
};
const sessionPrivacy = (input: ParsedInput) =>
  input.session.origin !== "artifact" && (input.session.private ?? false);
const requireArtifactSessionMatch = (
  input: ParsedInput,
  session: typeof sessions.$inferSelect
) => {
  if (
    input.session.origin === "artifact" &&
    (session.origin !== "artifact" ||
      session.externalKey !== input.session.externalKey)
  ) {
    throw new ServiceError("not_found", "Session not found");
  }
};

interface StartResult {
  runId: string;
  sessionId: string;
  status: RunRecord["status"];
}

/**
 * A requestId is a retry key for one caller on one agent. Another caller's
 * run is not handed back, whatever id they picked.
 */
const refuseForeignRequest = (
  existing: RunRecord,
  agentId: string,
  subject: Subject,
  scopeArtifactId: string | null
): void => {
  // Two runs of one agent share an actor, so the run tree and the person
  // behind it tell them apart.
  if (
    existing.scopeArtifactId !== scopeArtifactId ||
    existing.agentId !== agentId ||
    existing.actor.id !== subject.actor.id ||
    existing.actor.kind !== subject.actor.kind ||
    existing.parentRunId !== subject.parentRunId ||
    existing.onBehalfOfUserId !== subject.onBehalfOfUserId
  ) {
    throw new ServiceError(
      "conflict",
      "That requestId is already used by another request"
    );
  }
};

/** A peer's request, or a wake carrying a peer's answer: a run a peer's text sets going. */
const startsFromPeerText = (principal: Principal, options: StartRunOptions) =>
  principal.kind === "peer" || options.wakeOf !== undefined;

export const createRunsService = ({
  adapters,
  authorizeGuestGrant,
  guestAdapter,
  guestRuntimeReady,
  guestsOff,
  people,
  atomic,
  blobs,
  clock,
  db,
  devFakeRuntime,
  gateways,
  library,
  runTokenKey,
  secrets,
}: RunsServiceOptions) => {
  const eventsService = createEventsService({ blobs, db, people });
  const adapterByKind = new Map<string, RuntimeAdapter>(
    adapters.map((adapter) => [adapter.kind, adapter])
  );
  if (devFakeRuntime) {
    adapterByKind.set("fake", createFakeRuntime());
  }
  const gatewayByKind = new Map<string, Gateway>([
    [noneGateway.kind, noneGateway],
    ...gateways.map((gateway): [string, Gateway] => [gateway.kind, gateway]),
  ]);

  const nowIso = () => clock.now().toISOString();

  /** The masker for the secrets this run's agent holds, or null. */
  const runMasker = (run: RunRecord): Promise<Masker | null> =>
    secrets
      ? secrets.maskerFor(run.workspaceId, run.agentId)
      : Promise.resolve(null);

  const requireRun = async (
    principal: Principal,
    runId: string
  ): Promise<RunRecord> => {
    const run = await loadRun(
      db,
      runId,
      principal.kind === "system" ? undefined : principal.workspaceId
    );
    if (!run) {
      throw new ServiceError("not_found", "Run not found");
    }
    return run;
  };

  /**
   * A user reaches the runs of the sessions it can see. A run of a hidden
   * session answers the same not-found as an unknown id.
   */
  const requireVisibleSession = async (
    principal: Principal,
    run: RunRecord
  ): Promise<void> => {
    if (principal.kind !== "user" && principal.kind !== "run") {
      return;
    }
    if (principal.kind === "run") {
      const caller = await loadRun(db, principal.runId, principal.workspaceId);
      await requireCurrentGuest(caller);
      if (!caller || caller.agentId !== principal.agentId) {
        throw new ServiceError("not_found", "Run not found");
      }
      if (!caller.scopeArtifactId) {
        const [session] = await db
          .select({ origin: sessions.origin })
          .from(sessions)
          .where(
            and(
              eq(sessions.id, run.sessionId),
              eq(sessions.workspaceId, principal.workspaceId)
            )
          )
          .limit(1);
        if (session && session.origin !== "artifact") {
          return;
        }
      }
    }
    const [visible] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          await visibleSessions(db, principal, nowIso()),
          eq(sessions.id, run.sessionId)
        )
      )
      .limit(1);
    if (!visible) {
      throw new ServiceError("not_found", "Run not found");
    }
  };

  const appendRunEvent = (
    run: RunRecord,
    type: Parameters<typeof eventsService.append>[0]["type"],
    actor: Actor,
    payload: Record<string, unknown> = {}
  ) => {
    const result = eventsService.append({
      actor,
      agentId: run.agentId,
      payload,
      runId: run.id,
      sessionId: run.sessionId,
      type,
      workspaceId: run.workspaceId,
    });
    return result.then(async (event) => {
      if (["run.finished", "run.failed", "run.interrupted"].includes(type)) {
        await cancelSubagentTree(run);
      }
      return event;
    });
  };

  const agentActor = (run: RunRecord): Actor => ({
    id: run.agentId,
    kind: "agent",
  });

  const requireSystem = (principal: Principal, action: string) => {
    if (principal.kind !== "system") {
      throw new ForbiddenError(action);
    }
  };

  /** Who may write to a run: in-process runtimes, or the machine that claimed it. */
  const authorizeRunWrite = async (
    principal: Principal,
    run: RunRecord,
    action: string
  ) => {
    authorize(principal, action, {
      id: run.id,
      kind: RUN_KIND,
      workspaceId: run.workspaceId,
    });
    if (run.scopeArtifactId) {
      await adapterFor(run);
    }
    const allowed =
      principal.kind === "system" ||
      (principal.kind === "machine" && run.claimedBy === principal.machineId);
    if (!allowed) {
      throw new ForbiddenError(action);
    }
  };

  const requireGuestsEnabled = () => {
    if (guestsOff?.() ?? true) {
      throw guestUnavailable();
    }
  };
  const requireCurrentGuest = async (run: RunRecord | null) => {
    if (!run?.scopeArtifactId) {
      return;
    }
    requireGuestsEnabled();
    const [valid] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, run.id), currentGuestRun(nowIso())));
    if (!valid) {
      throw guestUnavailable();
    }
  };

  const adapterFor = async (
    run: RunRecord
  ): Promise<{
    adapter: RuntimeAdapter | undefined;
    agent: Awaited<ReturnType<typeof findAgent>>;
  }> => {
    await requireCurrentGuest(run);
    const agent = await findAgent(db, {
      id: run.agentId,
      workspaceId: run.workspaceId,
    });
    if (
      run.scopeArtifactId &&
      !(authorizeGuestGrant && agent && guestRuntimeReady?.(agent.runtime))
    ) {
      throw guestUnavailable();
    }
    if (run.scopeArtifactId) {
      requireGuestsEnabled();
    }
    // A dry run is on the cloud runtime for good, even when its agent moves.
    return {
      adapter: agent
        ? (run.scopeArtifactId && guestAdapter) ||
          adapterByKind.get(run.dryRun ? "cloud" : agent.runtime)
        : undefined,
      agent,
    };
  };

  const guardScopedRuntime = async (principal: Principal, runId: string) => {
    const run = await loadRun(
      db,
      runId,
      principal.kind === "system" ? undefined : principal.workspaceId
    );
    if (run?.scopeArtifactId) {
      await adapterFor(run);
    }
  };

  const adapterDeps: AdapterDeps = {
    claimRun: (principal, runId, options) =>
      claimRun(principal, runId, options),
    clock,
    completeRun: (principal, runId, result) =>
      completeRun(principal, runId, result),
    ingestRunEvents: (principal, runId, batch) =>
      ingestRunEvents(principal, runId, batch),
  };

  /**
   * The managed runtime never asks `needsApproval`, so work a peer's text set
   * going cannot be handed to a managed agent: its tools could not be held.
   */
  const refusePeerHandoffToManaged = async (
    runtime: AgentRuntime,
    parentRunId: string | null,
    workspaceId: string,
    startedByPeer: boolean
  ) => {
    if (runtime !== "managed") {
      return;
    }
    const parent = parentRunId
      ? await loadRun(db, parentRunId, workspaceId)
      : null;
    if (startedByPeer || (parent && (await peerRootOf(db, parent)) !== null)) {
      throw new ServiceError(
        "invalid",
        "An agent on the managed runtime can't take work that started with a message from a peer, because its tool calls can't be held for approval."
      );
    }
  };

  type Prepared = Awaited<ReturnType<typeof prepareStart>>;

  const refuseScopedHandoff = async (principal: Principal) => {
    if (principal.kind !== "run") {
      return;
    }
    const parent = await loadRun(db, principal.runId, principal.workspaceId);
    if (parent?.scopeArtifactId) {
      throw new ForbiddenError(START_ACTION);
    }
  };

  /** Everything `startRun` checks before it writes. */
  const prepareStart = async (
    principal: Principal,
    input: ParsedInput,
    options: StartRunOptions
  ) => {
    const agent = await findAgent(db, {
      id: input.agentId,
      workspaceId:
        principal.kind === "system" ? undefined : principal.workspaceId,
    });
    const dryRunDraft = options.dryRun === true && agent?.status === "draft";
    if (!agent || (agent.status !== "active" && !dryRunDraft)) {
      throw new ServiceError("not_found", "Agent not found");
    }
    authorize(principal, START_ACTION, {
      kind: RUN_KIND,
      workspaceId: agent.workspaceId,
    });
    const adapter = adapterByKind.get(options.dryRun ? "cloud" : agent.runtime);
    if (!adapter) {
      throw new ServiceError(
        "invalid",
        `No runtime is registered for ${agent.runtime} agents`
      );
    }
    if (!gatewayByKind.has(input.reply.kind)) {
      throw new ServiceError(
        "invalid",
        `No gateway is registered for ${input.reply.kind} replies`
      );
    }
    assertArtifactReply(input);
    if (input.session.origin === "artifact") {
      await authorizeArtifactRun(
        db,
        principal,
        input.session.externalKey ?? "",
        agent.workspaceId,
        clock.now()
      );
    }
    const subject = await deriveSubject(
      db,
      principal,
      agent.id,
      options.wakeOf,
      options.subagent !== undefined
    );
    await refuseScopedHandoff(principal);
    await refusePeerHandoffToManaged(
      agent.runtime,
      subject.parentRunId,
      agent.workspaceId,
      startsFromPeerText(principal, options)
    );
    const fileIds = [...new Set(input.input.fileIds)];
    if (fileIds.length > 0 && subject.onBehalfOfUserId === null) {
      throw new ServiceError("invalid", "This caller cannot attach files");
    }
    await requireFiles(db, {
      fileIds,
      ownerUserId: subject.onBehalfOfUserId ?? undefined,
      workspaceId: agent.workspaceId,
    });
    return {
      adapter,
      agent,
      fileIds,
      guestAuthorization: undefined as
        | { grant: GuestGrant; memberId: string; sessionId: string }
        | undefined,
      principal,
      scopeArtifactId: null as string | null,
      subject,
    };
  };

  /**
   * The `run.queued` and `message.user` events of a new run as statements, for
   * a caller that wants them in the same atomic write as the run.
   */
  const queuedEvents = ({
    agent,
    fileIds,
    input,
    runId,
    sessionId,
    subject,
  }: {
    agent: Prepared["agent"];
    fileIds: string[];
    input: ParsedInput;
    runId: string;
    sessionId: string;
    subject: Subject;
  }): Statement[] => {
    const base = {
      actor: subject.actor,
      agentId: agent.id,
      runId,
      sessionId,
      workspaceId: agent.workspaceId,
    };
    return [
      eventsService.insertStatement({
        ...base,
        payload: { depth: subject.depth, origin: input.session.origin },
        type: "run.queued",
      }),
      eventsService.insertStatement({
        ...base,
        payload: {
          fileIds,
          text: input.input.text.slice(0, EVENT_TEXT_CHARS),
        },
        type: "message.user",
      }),
    ];
  };

  /** What a trusted caller wants in the same atomic write as the run. */
  const extraWrites = (
    queued: Parameters<typeof queuedEvents>[0],
    options: StartRunOptions
  ): Statement[] => [
    ...(options.offerLater ? queuedEvents(queued) : []),
    ...(options.alongside?.({
      runId: queued.runId,
      sessionId: queued.sessionId,
    }) ?? []),
  ];

  /** The session this run continues, if any: the trusted `sessionId`, else the one for the key. */
  const knownSession = async (
    { agent, subject, principal, scopeArtifactId }: Prepared,
    input: ParsedInput,
    options: StartRunOptions
  ) => {
    requireOwnMainKey(subject.actor, input);
    if (options.sessionId) {
      const session = await findSessionById(db, {
        agentId: agent.id,
        id: options.sessionId,
        workspaceId: agent.workspaceId,
      });
      if (!session) {
        throw new ServiceError("not_found", "Session not found");
      }
      if (
        scopeArtifactId &&
        (session.private ||
          session.origin !== "artifact" ||
          session.externalKey !== scopeArtifactId)
      ) {
        throw guestUnavailable();
      }
      requireArtifactSessionMatch(input, session);
      if (session.origin === "artifact" && !scopeArtifactId) {
        await authorizeArtifactRun(
          db,
          principal,
          session.externalKey ?? "",
          agent.workspaceId,
          clock.now()
        );
      }
      return session;
    }
    return input.session.externalKey
      ? await findSession(db, {
          actor: subject.actor,
          agentId: agent.id,
          externalKey: input.session.externalKey,
          origin: input.session.origin,
          workspaceId: agent.workspaceId,
        })
      : null;
  };

  /**
   * Writes the session (new, or its last-run time) and the run in one atomic
   * write. A duplicate `requestId` fails the unique index; the run that won is
   * read back and returned instead.
   */
  const guestInsertion = (prepared: Prepared, runId: string, at: string) => {
    const binding = prepared.guestAuthorization;
    if (!binding) {
      return { after: [], before: [] };
    }
    requireGuestsEnabled();
    return {
      after: [
        db.insert(guestRunScopes).values({
          memberId: binding.memberId,
          runId,
          sessionId: binding.sessionId,
          workspaceId: prepared.agent.workspaceId,
        }),
      ],
      before: [guestStartGuard(db, binding.grant, binding, at)],
    };
  };

  const recoverInsertion = async (
    error: unknown,
    prepared: Prepared,
    input: ParsedInput
  ) => {
    const mayRetry = prepared.guestAuthorization || isUniqueViolation(error);
    const existing =
      input.requestId && mayRetry
        ? await loadRunByRequest(
            db,
            prepared.agent.workspaceId,
            input.requestId
          )
        : null;
    if (existing) {
      refuseForeignRequest(
        existing,
        prepared.agent.id,
        prepared.subject,
        prepared.scopeArtifactId
      );
      await requireCurrentGuest(existing);
      return {
        inserted: false,
        runId: existing.id,
        sessionId: existing.sessionId,
        status: existing.status,
      };
    }
    if (prepared.guestAuthorization && isGuestStartGuardFailure(error)) {
      throw guestUnavailable();
    }
    let cause = error;
    for (let i = 0; i < 5 && cause instanceof Error; i += 1) {
      if (
        cause.message.includes("NOT NULL constraint failed: runs.input_text")
      ) {
        throw new ServiceError(
          "conflict",
          "The parent ended or already has 5 live subagents"
        );
      }
      ({ cause } = cause);
    }
    throw error;
  };

  /** Runs inside the same atomic write as the child: concurrent starts cannot exceed five. */
  const subagentGuard = (
    prepared: Prepared,
    options: StartRunOptions
  ): Statement[] => {
    if (!(options.subagent && prepared.subject.parentRunId)) {
      return [];
    }
    const parentId = prepared.subject.parentRunId;
    return [
      db
        .update(runs)
        .set({
          inputText: sql`case when ${inArray(runs.status, LIVE)} and
        (select subagents from agents where id = ${runs.agentId}) = 1 and
        not exists (with recursive ancestors(id, parent_run_id, status, agent_id, subagent_level, hops) as (
          select id, parent_run_id, status, agent_id, subagent_level, 0 from runs where id = ${parentId}
          union all select r.id, r.parent_run_id, r.status, r.agent_id, r.subagent_level, a.hops + 1 from runs r
            join ancestors a on r.id = a.parent_run_id
            where a.subagent_level > 0 and r.agent_id = a.agent_id and a.hops < ${MAX_RUN_DEPTH}
        ) select 1 from ancestors where status not in ('running','waiting')) and
        (select count(*) from runs child where child.parent_run_id = ${parentId}
          and child.subagent_level > 0 and child.status in ('queued','offered','running','waiting')) < 5
        then ${runs.inputText} else null end`,
        })
        .where(eq(runs.id, parentId)),
    ];
  };

  const insertOnce = async (
    prepared: Prepared,
    input: ParsedInput,
    options: StartRunOptions
  ): Promise<StartResult & { inserted: boolean }> => {
    const { agent, fileIds, subject } = prepared;
    const { workspaceId } = agent;
    const known = await knownSession(prepared, input, options);
    const now = clock.now();
    const created = now.toISOString();
    const runId = nextRunId(now.getTime());
    const sessionId = known?.id ?? ulid(now.getTime());
    const sessionActor =
      options.subagent && sessionPrivacy(input) && subject.onBehalfOfUserId
        ? { id: subject.onBehalfOfUserId, kind: "user" as const }
        : subject.actor;
    const sessionWrite: Statement = known
      ? db
          .update(sessions)
          .set({
            lastRunAt: created,
            ...artifactSelectionPatch(known, agent.id),
          })
          .where(eq(sessions.id, known.id))
      : db.insert(sessions).values({
          actorId: sessionActor.id,
          actorKind: sessionActor.kind,
          agentId: agent.id,
          createdAt: created,
          // Without a key the session is its own key, so the UI can send the
          // next message to it by id.
          externalKey: input.session.externalKey ?? sessionId,
          id: sessionId,
          lastRunAt: created,
          origin: input.session.origin,
          // The session of the run that started this one, when a run did.
          parentSessionId: parentSessionOf(subject.parentRunId),
          private: sessionPrivacy(input),
          workspaceId,
        });
    const runWrite = db.insert(runs).values({
      accessScope: options.subagent
        ? JSON.stringify(options.subagent.accessScope)
        : null,
      actorId: subject.actor.id,
      actorKind: subject.actor.kind,
      agentId: agent.id,
      createdAt: created,
      depth: subject.depth,
      dryRun: options.dryRun ?? false,
      id: runId,
      inputFileIds: JSON.stringify(fileIds),
      inputText: input.input.text,
      model: options.subagent ? options.subagent.model : null,
      onBehalfOfUserId: subject.onBehalfOfUserId,
      outputFileIds: "[]",
      parentRunId: subject.parentRunId,
      pendingFiles: options.pendingFiles?.length
        ? JSON.stringify(options.pendingFiles)
        : null,
      reply: JSON.stringify(input.reply),
      requestId: input.requestId ?? null,
      scopeArtifactId: prepared.scopeArtifactId,
      sessionId,
      status: "queued",
      subagentLevel: options.subagent ? options.subagent.level : 0,
      workspaceId,
    });
    const guestWrites = guestInsertion(prepared, runId, created);
    try {
      await atomic([
        ...guestWrites.before,
        ...subagentGuard(prepared, options),
        sessionWrite,
        runWrite,
        ...guestWrites.after,
        ...extraWrites(
          { agent, fileIds, input, runId, sessionId, subject },
          options
        ),
      ]);
      return { inserted: true, runId, sessionId, status: "queued" };
    } catch (error) {
      return recoverInsertion(error, prepared, input);
    }
  };

  /**
   * Two first messages with one session key race on the session index. The
   * loser finds the session on a second try.
   */
  const insertRun = async (
    prepared: Prepared,
    input: ParsedInput,
    options: StartRunOptions
  ) => {
    try {
      return await insertOnce(prepared, input, options);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      return await insertOnce(prepared, input, options);
    }
  };

  /**
   * A run's task folder. A failure is logged and the run goes on: the folder
   * is for the run's output, and the run can still do its work without it.
   */
  const makeTaskFolder = async (
    agent: Prepared["agent"],
    runId: string
  ): Promise<void> => {
    try {
      await library?.mkdir(
        {
          agentId: agent.id,
          kind: "run",
          runId,
          workspaceId: agent.workspaceId,
        },
        taskFolderPath(agent.slug, runId)
      );
    } catch (error) {
      console.error(
        "Creating the run's task folder failed",
        error instanceof Error ? error.name : "unknown"
      );
    }
  };

  /**
   * `options` is for trusted callers inside the Worker, never the request:
   * the Slack route passes the file descriptors that are still to be fetched
   * and the rows that must land in the same atomic write as the run.
   */
  const startRun = async (
    principal: Principal,
    rawInput: StartRunInput,
    options: StartRunOptions = {}
  ): Promise<StartResult> => {
    const input = startRunInputSchema.parse(rawInput);
    const prepared = await prepareStart(principal, input, options);
    return finishStart(prepared, input, options);
  };

  /** Read-only admission probe. The start path repeats this check before charging. */
  const guestReadiness = async (grant: GuestGrant, agentId: string) => {
    if (
      !(authorizeGuestGrant && guestRuntimeReady) ||
      (guestsOff?.() ?? true) ||
      grant.role === "viewer" ||
      Date.parse(grant.expiresAt) <= clock.now().getTime()
    ) {
      throw guestUnavailable();
    }
    const agent = await findAgent(db, {
      id: agentId,
      workspaceId: grant.workspaceId,
    });
    const adapter = agent && (guestAdapter ?? adapterByKind.get(agent.runtime));
    if (
      agent?.status !== "active" ||
      !adapter ||
      !guestRuntimeReady(agent.runtime)
    ) {
      throw guestUnavailable();
    }
    try {
      await authorizeGuestGrant(grant, {
        agentId: agent.id,
        artifactId: grant.artifactId,
        workspaceId: grant.workspaceId,
      });
    } catch (error) {
      if (error instanceof ForbiddenError) {
        throw guestUnavailable();
      }
      throw error;
    }
    return { adapter, agent };
  };

  const startForGuest = async (
    rawGrant: GuestGrant,
    rawInput: StartRunInput,
    options: Pick<StartRunOptions, "offerLater" | "sessionId" | "alongside"> & {
      guestSessionToken?: string;
    } = {}
  ): Promise<StartResult> => {
    const grant = guestGrantSchema.parse(rawGrant);
    const input = startRunInputSchema.parse(rawInput);
    if (
      !(authorizeGuestGrant && guestRuntimeReady) ||
      (guestsOff?.() ?? true) ||
      Date.parse(grant.expiresAt) <= clock.now().getTime() ||
      grant.role === "viewer" ||
      input.session.private === true ||
      input.session.origin !== "artifact" ||
      input.session.externalKey !== grant.artifactId ||
      input.input.fileIds.length ||
      input.reply.kind !== "none"
    ) {
      throw guestUnavailable();
    }
    const { agent, adapter } = await guestReadiness(grant, input.agentId);
    const binding = await authenticateGuestRun(
      db,
      grant,
      options.guestSessionToken,
      nowIso()
    );
    return finishStart(
      {
        adapter,
        agent,
        fileIds: [],
        guestAuthorization: { grant, ...binding },
        principal: SYSTEM_PRINCIPAL,
        scopeArtifactId: grant.artifactId,
        subject: {
          actor: { id: grant.guestId, kind: "guest" },
          depth: 0,
          onBehalfOfUserId: null,
          parentRunId: null,
        },
      },
      input,
      options
    );
  };

  const finishStart = async (
    prepared: Prepared,
    input: ParsedInput,
    options: StartRunOptions
  ): Promise<StartResult> => {
    const { inserted, ...started } = await insertRun(prepared, input, options);
    if (inserted && options.dryRun !== true && !prepared.scopeArtifactId) {
      await makeTaskFolder(prepared.agent, started.runId);
    }
    if (inserted && options.offerLater) {
      // `queuedEvents` wrote these in the atomic write, which skips the
      // listeners, so the stream hears of them here.
      try {
        await eventsService.notifyStored(
          prepared.agent.workspaceId,
          started.runId,
          ["run.queued", "message.user"]
        );
      } catch (error) {
        console.error("Run start listeners failed", error);
      }
    }
    if (!inserted || options.offerLater) {
      return started;
    }
    const run = await loadRun(db, started.runId, prepared.agent.workspaceId);
    if (!run) {
      throw new ServiceError("not_found", "Run not found");
    }
    const { actor } = prepared.subject;
    await appendRunEvent(run, "run.queued", actor, {
      depth: run.depth,
      origin: input.session.origin,
    });
    await appendRunEvent(run, "message.user", actor, {
      fileIds: prepared.fileIds,
      text: input.input.text,
    });
    // A run with pending files is offered once they are fetched.
    if (!run.pendingFiles) {
      await offerRun(run);
    }
    return started;
  };

  let importedTokenKey: Promise<CryptoKey> | undefined;
  const signToken = async (claims: RunTokenClaims) => {
    if (!runTokenKey) {
      throw new Error("Machine claims need runTokenKey (RUN_TOKEN_KEY).");
    }
    importedTokenKey ??= importRunTokenKey(runTokenKey);
    return await signRunToken(await importedTokenKey, claims);
  };

  /**
   * A machine's daemon claims a run over HTTP (seam 3). The conditional write
   * is in `claimForMachine`. 403 when the run's agent is on another machine,
   * 409 when the run cannot be claimed now.
   */
  const claimRunForMachine = async (
    principal: Principal,
    runId: string,
    options: {
      libraryForDaemon?: boolean;
      libraryLiveForDaemon?: boolean;
      currentApprovalsForDaemon?: boolean;
      requestsForDaemon?: boolean;
      platformUrl: string;
    }
  ): Promise<MachineClaim> => {
    await guardScopedRuntime(principal, runId);
    return claimForMachine(
      {
        announceStarted: async (run) => {
          await appendRunEvent(run, "run.started", agentActor(run));
        },
        db,
        leaseMs: LEASE_MS,
        library,
        now: () => clock.now(),
        secrets,
        signToken,
      },
      principal,
      runId,
      options
    );
  };

  const claimRun = async (
    principal: Principal,
    runId: string,
    options?: { leaseMs?: number }
  ): Promise<RunRecord> => {
    requireSystem(principal, "runs.claim");
    await guardScopedRuntime(principal, runId);
    const sibling = alias(runs, "sibling");
    const older = alias(runs, "older");
    const hasComputer = exists(
      db
        .select({ id: agentRows.id })
        .from(agentRows)
        .where(
          and(
            eq(agentRows.id, runs.agentId),
            or(
              isNotNull(agentRows.computerMachineId),
              and(
                eq(agentRows.runtime, "cloud"),
                sql`json_extract(${agentRows.runtimeConfig}, '$.environment') = 'linux-vm'`
              )
            )
          )
        )
    );
    const claimed = await db
      .update(runs)
      .set({
        claimedBy: "system",
        leaseUntil: new Date(
          clock.now().getTime() + (options?.leaseMs ?? LEASE_MS)
        ).toISOString(),
        startedAt: nowIso(),
        status: "running",
      })
      .where(
        and(
          eq(runs.id, runId),
          currentGuestRun(nowIso()),
          inArray(runs.status, STARTING),
          // A run with pending Slack files is not claimable.
          isNull(runs.pendingFiles),
          // One running run per agent; a waiting run still holds its agent.
          notExists(
            db
              .select({ id: sibling.id })
              .from(sibling)
              .where(
                and(
                  or(
                    and(
                      eq(sibling.agentId, runs.agentId),
                      or(
                        and(
                          eq(sibling.subagentLevel, 0),
                          eq(runs.subagentLevel, 0)
                        ),
                        hasComputer
                      )
                    ),
                    eq(sibling.sessionId, runs.sessionId)
                  ),
                  inArray(sibling.status, LIVE)
                )
              )
          ),
          // An agent's runs start in the order they were created, across its
          // sessions: no older one may still be waiting.
          notExists(
            db
              .select({ id: older.id })
              .from(older)
              .where(
                and(
                  or(
                    and(
                      eq(older.agentId, runs.agentId),
                      or(
                        and(
                          eq(older.subagentLevel, 0),
                          eq(runs.subagentLevel, 0)
                        ),
                        hasComputer
                      )
                    ),
                    eq(older.sessionId, runs.sessionId)
                  ),
                  inArray(older.status, STARTING),
                  or(
                    lt(older.createdAt, runs.createdAt),
                    and(
                      eq(older.createdAt, runs.createdAt),
                      lt(older.id, runs.id)
                    )
                  )
                )
              )
          )
        )
      )
      .returning({ id: runs.id });
    if (claimed.length === 0) {
      await guardScopedRuntime(principal, runId);
      throw new ServiceError("conflict", "Run cannot be claimed");
    }
    const run = await loadRun(db, runId);
    if (!run) {
      throw new ServiceError("not_found", "Run not found");
    }
    await appendRunEvent(run, "run.started", agentActor(run));
    return run;
  };

  /**
   * Undoes a system claim whose runtime could not start the work. Only a
   * `running` run claimed by the system moves back to `offered`. A run in any
   * other state, such as one cancelled meanwhile, is left as it is.
   */
  const releaseRun = async (
    principal: Principal,
    runId: string
  ): Promise<void> => {
    requireSystem(principal, "runs.release");
    await db
      .update(runs)
      .set({
        claimedBy: null,
        leaseUntil: null,
        startedAt: null,
        status: "offered",
      })
      .where(
        and(
          eq(runs.id, runId),
          eq(runs.status, "running"),
          eq(runs.claimedBy, "system")
        )
      );
  };

  /**
   * The run asked a person something: `running` moves to `waiting`. The
   * heartbeat and the event upload carry on, and the lease keeps running, so a
   * runtime that dies while waiting is still reaped. Returns false, and
   * changes nothing, for a run that is not `running`.
   */
  const markWaiting = async (
    principal: Principal,
    runId: string
  ): Promise<boolean> => {
    requireSystem(principal, "runs.wait");
    const run = await requireRun(principal, runId);
    if (run.scopeArtifactId) {
      await adapterFor(run);
    }
    const moved = await db
      .update(runs)
      .set({ status: "waiting" })
      .where(
        and(
          eq(runs.id, run.id),
          currentGuestRun(nowIso()),
          eq(runs.status, "running")
        )
      )
      .returning({ id: runs.id });
    if (moved.length === 0) {
      await requireCurrentGuest(run);
      return false;
    }
    await appendRunEvent(run, "run.waiting", agentActor(run));
    return true;
  };

  /**
   * The answer came: `waiting` moves back to `running` and the lease restarts
   * from now, since the runtime's last heartbeat may be old. The lease is the
   * agent's runtime's own (90 seconds for a machine, 10 minutes for a cloud or
   * managed run) unless `options.leaseMs` says otherwise. Returns false, and
   * changes nothing, for a run that is not `waiting`, such as a cancelled one.
   */
  const markRunning = async (
    principal: Principal,
    runId: string,
    options?: { leaseMs?: number }
  ): Promise<boolean> => {
    requireSystem(principal, "runs.resume");
    const run = await requireRun(principal, runId);
    const { agent } = await adapterFor(run);
    const runtimeLeaseMs =
      (agent && RUNTIME_LEASE_MS[agent.runtime]) ?? LEASE_MS;
    const moved = await db
      .update(runs)
      .set({
        leaseUntil: new Date(
          clock.now().getTime() + (options?.leaseMs ?? runtimeLeaseMs)
        ).toISOString(),
        status: "running",
      })
      .where(
        and(
          eq(runs.id, run.id),
          eq(runs.status, "waiting"),
          currentGuestRun(nowIso())
        )
      )
      .returning({ id: runs.id });
    if (moved.length === 0) {
      await requireCurrentGuest(run);
      return false;
    }
    await appendRunEvent(run, "run.resumed", agentActor(run));
    return true;
  };

  /** Deliver a closed request through the runtime owned by this run. */
  const resumeRequest = async (
    principal: Principal,
    runId: string,
    request: import("./requests.ts").RequestRecord
  ): Promise<void> => {
    requireSystem(principal, "runs.resume");
    const run = await requireRun(principal, runId);
    if (TERMINAL_STATUSES.includes(run.status)) {
      return;
    }
    const { adapter } = await adapterFor(run);
    await adapter?.resume?.(run, request);
  };

  const ingestRunEvents = async (
    principal: Principal,
    runId: string,
    batch: readonly RunEventInput[]
  ): Promise<{ lastSeq: number }> => {
    const parsed = runEventsSchema.parse(batch);
    const run = await requireRun(principal, runId);
    await authorizeRunWrite(principal, run, "runs.ingest");
    if (!LIVE.includes(run.status)) {
      throw new ServiceError("conflict", `Run is ${run.status}, not running`);
    }
    const [last] = await db
      .select({ seq: max(events.seq) })
      .from(events)
      .where(
        and(eq(events.runId, run.id), eq(events.workspaceId, run.workspaceId))
      );
    let lastSeq = last?.seq ?? 0;
    // A batch the daemon sent twice is stored once.
    const fresh = parsed
      .filter((event) => event.seq > lastSeq)
      .sort((a, b) => a.seq - b.seq);
    const masker = fresh.length > 0 ? await runMasker(run) : null;
    for (const event of fresh) {
      // biome-ignore lint/performance/noAwaitInLoops: events are stored in seq order
      await eventsService.append(
        {
          actor: agentActor(run),
          agentId: run.agentId,
          payload: masker ? masker.maskDeep(event.payload) : event.payload,
          runId: run.id,
          seq: event.seq,
          sessionId: run.sessionId,
          type: event.type,
          workspaceId: run.workspaceId,
        },
        run.scopeArtifactId
          ? () => {
              requireGuestsEnabled();
              return sql`exists (select 1 from ${runs} where ${runs.id} = ${run.id}
          and ${runs.workspaceId} = ${run.workspaceId} and ${currentGuestRun(nowIso())})`;
            }
          : undefined
      );
      lastSeq = event.seq;
    }
    if (
      fresh.some(
        (event) => event.type === "tool.result" && event.payload.ok === false
      )
    ) {
      await stopOnRepeat(run);
    }
    return { lastSeq };
  };

  /**
   * Records what a dry run would have done instead of doing it, as a
   * `run.dry_run_skipped` event. The summary is masked with the agent's
   * secrets, then cut to `DRY_RUN_SUMMARY_MAX` characters. It bypasses
   * `ingestRunEvents`, whose `seq` numbering belongs to `toRunEvents`. Only
   * the run itself, or the system, may write it, and only on a live dry run.
   */
  const recordDryRunSkip = async (
    principal: Principal,
    runId: string,
    skip: { summary: string; tool: string }
  ): Promise<void> => {
    const { summary, tool } = dryRunSkipSchema.parse(skip);
    const run = await requireRun(principal, runId);
    authorize(principal, "runs.dry_run_skip", {
      id: run.id,
      kind: RUN_KIND,
      workspaceId: run.workspaceId,
    });
    if (
      principal.kind !== "system" &&
      !(principal.kind === "run" && principal.runId === run.id)
    ) {
      throw new ForbiddenError("runs.dry_run_skip");
    }
    if (!run.dryRun) {
      throw new ServiceError("conflict", "Run is not a dry run");
    }
    if (!LIVE.includes(run.status)) {
      throw new ServiceError("conflict", `Run is ${run.status}, not running`);
    }
    const masker = await runMasker(run);
    await appendRunEvent(run, "run.dry_run_skipped", agentActor(run), {
      summary: (masker ? masker.mask(summary) : summary).slice(
        0,
        DRY_RUN_SUMMARY_MAX
      ),
      tool: masker ? masker.mask(tool) : tool,
    });
  };

  /**
   * Ends a run that repeats one failing call `REPEAT_STOP_AT` times in a row, as
   * counted over its recent tool events. A cloud run is stopped by its own
   * runner, which keeps its usage, so it is left alone here. The stop is
   * conditional on the run still running, so it is recorded once.
   */
  const stopOnRepeat = async (run: RunRecord): Promise<void> => {
    const { adapter } = await adapterFor(run);
    if (!adapter || adapter.kind === "cloud") {
      return;
    }
    const rows = await db
      .select({ payload: events.payload, type: events.type })
      .from(events)
      .where(
        and(
          eq(events.runId, run.id),
          eq(events.workspaceId, run.workspaceId),
          inArray(events.type, ["tool.call", "tool.result"])
        )
      )
      .orderBy(desc(events.seq))
      .limit(RECENT_TOOL_EVENTS);
    const streak = streakOf(toolOutcomes(rows.reverse()));
    if (!streak || streak.count < REPEAT_STOP_AT) {
      return;
    }
    const stop: RunStop = {
      count: streak.count,
      kind: "repeat",
      tool: streak.tool,
    };
    const line = stopMessage(stop);
    const stopped = await db
      .update(runs)
      .set({ error: line, finishedAt: nowIso(), status: "failed" })
      .where(
        and(
          eq(runs.id, run.id),
          currentGuestRun(nowIso()),
          eq(runs.status, "running")
        )
      )
      .returning({ id: runs.id });
    if (stopped.length === 0) {
      return;
    }
    await recordStop(run, stop, line);
    try {
      await adapter.cancel(db, run, adapterDeps);
    } catch (cancelError) {
      console.error(
        `Cancelling run ${run.id} after a repeat stop failed: ${cancelError instanceof Error ? cancelError.message : String(cancelError)}`
      );
    }
    await offerNextWaiting(run);
  };

  /**
   * The daemon is still working: the lease moves to 90 seconds from now, or
   * to `options.leaseMs` for a caller that is the system (a cloud run's object).
   * Refused with 409 unless the run is `running` or `waiting`. The write is conditional, so
   * a run the reaper just interrupted stays interrupted.
   */
  const heartbeatRun = async (
    principal: Principal,
    runId: string,
    options?: { leaseMs?: number }
  ): Promise<void> => {
    if (options?.leaseMs !== undefined) {
      requireSystem(principal, "runs.heartbeat.lease");
    }
    const run = await requireRun(principal, runId);
    await authorizeRunWrite(principal, run, "runs.heartbeat");
    const extended = await db
      .update(runs)
      .set({
        // ISO 8601: the run token check compares lease_until as text.
        leaseUntil: new Date(
          clock.now().getTime() + (options?.leaseMs ?? LEASE_MS)
        ).toISOString(),
      })
      .where(
        and(
          eq(runs.id, run.id),
          currentGuestRun(nowIso()),
          inArray(runs.status, LIVE)
        )
      )
      .returning({ id: runs.id });
    if (extended.length === 0) {
      await requireCurrentGuest(run);
      throw new ServiceError("conflict", `Run is ${run.status}, not running`);
    }
  };

  /** The daemon says the local process of an interrupted run has exited. */
  const recordProcessEnded = async (run: RunRecord) => {
    if (run.status !== "interrupted") {
      throw new ServiceError(
        "conflict",
        `Run is ${run.status}, not interrupted`
      );
    }
    const recorded = await db
      .update(runs)
      .set({ processEndedAt: nowIso() })
      .where(
        and(
          eq(runs.id, run.id),
          eq(runs.status, "interrupted"),
          isNull(runs.processEndedAt)
        )
      )
      .returning({ id: runs.id });
    // Accepted once: the first call records it, a repeat is refused.
    if (recorded.length === 0) {
      throw new ServiceError("conflict", "The process end is already recorded");
    }
  };

  /**
   * The claiming machine stopped a running run on its own (SIGTERM, a 1012
   * close). The process has already exited, so the run ends `interrupted` with
   * `process_ended_at` set, and Retry is offered at once.
   */
  const abortedCompletion = async (principal: Principal, run: RunRecord) => {
    if (!LIVE.includes(run.status)) {
      await recordProcessEnded(run);
      return;
    }
    const now = nowIso();
    const moved = await db
      .update(runs)
      .set({
        error: "Aborted by the machine",
        finishedAt: now,
        processEndedAt: now,
        status: "interrupted",
      })
      .where(
        and(
          eq(runs.id, run.id),
          currentGuestRun(nowIso()),
          inArray(runs.status, LIVE)
        )
      )
      .returning({ id: runs.id });
    if (moved.length === 0) {
      throw new ServiceError("conflict", "Run is no longer running");
    }
    await appendRunEvent(run, "run.interrupted", eventActor(principal));
  };

  const deliverReply = async (
    run: RunRecord,
    message: { fileIds: string[]; text: string }
  ) => {
    const gateway = gatewayByKind.get(run.reply.kind);
    if (!gateway) {
      throw new ServiceError(
        "invalid",
        `No gateway is registered for ${run.reply.kind} replies`
      );
    }
    await gateway.deliver(run.reply, message, {
      agentId: run.agentId,
      onBehalfOfUserId: run.onBehalfOfUserId,
      runId: run.id,
      sessionId: run.sessionId,
      workspaceId: run.workspaceId,
    });
  };

  /**
   * The Claude Code session id, valid only on the machine that ran it. The
   * write applies only while the run is still `running` or `waiting`, and goes in the same
   * atomic write as the run's own update.
   */
  const runtimeRefWrite = (
    principal: Principal,
    run: RunRecord,
    runtimeRef: string
  ): Statement =>
    db
      .update(sessions)
      .set({
        runtimeMachineId:
          principal.kind === "machine" ? principal.machineId : null,
        runtimeRef,
      })
      .where(
        and(
          eq(sessions.id, run.sessionId),
          eq(sessions.agentId, run.agentId),
          exists(
            db
              .select({ id: runs.id })
              .from(runs)
              .where(
                and(
                  eq(runs.id, run.id),
                  currentGuestRun(nowIso()),
                  inArray(runs.status, LIVE)
                )
              )
          )
        )
      );

  /** Records a safeguard stop: its event with the system actor, then `run.failed` with the line. */
  const recordStop = async (run: RunRecord, stop: RunStop, error: string) => {
    const event = stopEvent(stop);
    await appendRunEvent(
      run,
      event.type,
      eventActor(SYSTEM_PRINCIPAL),
      event.payload
    );
    await appendRunEvent(run, "run.failed", agentActor(run), { error });
  };

  /** Records a failed run: its safeguard stop first, when it has one, else `run.failed` alone. */
  const recordFailure = async (run: RunRecord, result: RunResultInput) => {
    if (result.stop) {
      await recordStop(run, result.stop, failureError(result));
      return;
    }
    await appendRunEvent(run, "run.failed", agentActor(run), {
      error: failureError(result),
    });
  };

  const completeRun = async (
    principal: Principal,
    runId: string,
    rawResult: RunResult
  ): Promise<void> => {
    const run = await requireRun(principal, runId);
    await authorizeRunWrite(principal, run, "runs.complete");
    const result = maskResult(
      runResultSchema.parse(rawResult),
      await runMasker(run)
    );
    if (result.status === "aborted") {
      await abortedCompletion(principal, run);
      return;
    }
    if (!LIVE.includes(run.status)) {
      throw new ServiceError("conflict", `Run is ${run.status}, not running`);
    }
    const fileIds = [...new Set(result.fileIds ?? [])];
    await requireFiles(db, {
      fileIds,
      runId: run.id,
      workspaceId: run.workspaceId,
    });
    const failed = result.status === "failed";
    const error = failed ? failureError(result) : null;
    const finishedAt = nowIso();
    const runWrite = db
      .update(runs)
      .set({
        error,
        finishedAt,
        resultText: result.text ?? null,
        status: result.status,
        usage: result.usage ? JSON.stringify(result.usage) : null,
      })
      .where(
        and(
          eq(runs.id, run.id),
          currentGuestRun(nowIso()),
          inArray(runs.status, LIVE)
        )
      );
    // The session write goes first: it only applies while the run is live.
    await atomic(
      result.runtimeRef
        ? [runtimeRefWrite(principal, run, result.runtimeRef), runWrite]
        : [runWrite]
    );
    const after = await loadRun(db, run.id);
    // Told apart from a concurrent completion with the same status by the
    // time this call wrote: only the call whose write applied sees its own.
    // Two calls within one millisecond still tie, because the table has no
    // per-call column to use as a nonce.
    if (after?.status !== result.status || after.finishedAt !== finishedAt) {
      throw new ServiceError("conflict", "Run is no longer running");
    }
    if (failed) {
      await recordFailure(run, result);
      await offerNextWaiting(run);
      return;
    }
    await appendRunEvent(run, "run.finished", agentActor(run));
    try {
      await deliverReply(run, { fileIds, text: result.text ?? "" });
    } finally {
      await offerNextWaiting(run);
    }
  };

  /** Only same-agent subagent edges confer ownership; a hand-off ends the chain. */
  const reachesSubagentParent = async (
    target: RunRecord,
    parent: { id: string; agentId: string; workspaceId: string }
  ): Promise<boolean> => {
    let cursor: RunRecord | null = target;
    for (let hops = 0; hops < MAX_RUN_DEPTH && cursor?.parentRunId; hops += 1) {
      if (cursor.agentId !== parent.agentId || cursor.subagentLevel === 0) {
        return false;
      }
      if (cursor.parentRunId === parent.id) {
        return true;
      }
      // biome-ignore lint/performance/noAwaitInLoops: each parent id comes from the previous run
      cursor = await loadRun(db, cursor.parentRunId, parent.workspaceId);
    }
    return false;
  };

  const getRun = async (
    principal: Principal,
    runId: string
  ): Promise<RunSummary> => {
    const run = await requireRun(principal, runId);
    authorize(principal, READ_ACTION, {
      id: run.id,
      kind: RUN_KIND,
      workspaceId: run.workspaceId,
    });
    await requireVisibleSession(principal, run);
    // A run reads its own agent's runs and the runs it started.
    if (
      principal.kind === "run" &&
      run.agentId !== principal.agentId &&
      run.parentRunId !== principal.runId &&
      run.subagentLevel === 0
    ) {
      throw new ServiceError("not_found", "Run not found");
    }
    if (
      principal.kind === "run" &&
      run.subagentLevel > 0 &&
      principal.runId !== run.id &&
      !(await reachesSubagentParent(run, {
        agentId: principal.agentId,
        id: principal.runId,
        workspaceId: principal.workspaceId,
      }))
    ) {
      throw new ServiceError("not_found", "Run not found");
    }
    return toSummary(run);
  };

  /**
   * Polls until the run is finished or `waitMs` has passed, then returns its
   * summary either way. A caller checks `status` to tell done from pending.
   */
  const waitForRun = async (
    principal: Principal,
    runId: string,
    waitMs: number
  ): Promise<RunSummary> => {
    const deadline =
      clock.now().getTime() + Math.min(Math.max(waitMs, 0), WAIT_MAX_MS);
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: polling is sequential by nature
      const summary = await getRun(principal, runId);
      const remaining = deadline - clock.now().getTime();
      if (TERMINAL_STATUSES.includes(summary.status) || remaining <= 0) {
        return summary;
      }
      await clock.sleep(Math.min(WAIT_POLL_MS, remaining));
    }
  };

  const cleanupAdapter = async (run: RunRecord) => {
    const agent = await findAgent(db, {
      id: run.agentId,
      workspaceId: run.workspaceId,
    });
    return agent
      ? (run.scopeArtifactId && guestAdapter) ||
          adapterByKind.get(run.dryRun ? "cloud" : agent.runtime)
      : undefined;
  };

  const cancelRun = async (
    principal: Principal,
    runId: string
  ): Promise<void> => {
    if (principal.kind === "run") {
      throw new ForbiddenError("runs.cancel");
    }
    const run = await requireRun(principal, runId);
    await requireVisibleSession(principal, run);
    authorize(principal, "runs.cancel", {
      id: run.id,
      kind: RUN_KIND,
      workspaceId: run.workspaceId,
    });
    await cancelOwnedRun(run, eventActor(principal));
  };

  const cancelOwnedRun = async (
    run: RunRecord,
    actor: Actor
  ): Promise<void> => {
    const cancelled = await db
      .update(runs)
      .set({ finishedAt: nowIso(), status: "cancelled" })
      .where(and(eq(runs.id, run.id), inArray(runs.status, ACTIVE)))
      .returning({ id: runs.id });
    if (cancelled.length === 0) {
      throw new ServiceError("conflict", `Run is already ${run.status}`);
    }
    await appendRunEvent(run, "run.cancelled", actor);
    const adapter = await cleanupAdapter(run);
    try {
      await adapter?.cancel(db, run, adapterDeps);
    } finally {
      try {
        await cancelSubagentTree(run);
      } catch (error) {
        console.error(`Cancelling subagents of ${run.id} failed:`, error);
      }
    }
    await offerNextWaiting(run);
  };

  /**
   * Counts a failed download and frees the run for the next try. The third
   * failure fails the run, with an event, and returns true; before that the
   * caller rethrows and a later attempt tries again.
   */
  const recordFailedDownload = async (run: RunRecord): Promise<boolean> => {
    const waiting = and(
      eq(runs.id, run.id),
      inArray(runs.status, STARTING),
      isNotNull(runs.pendingFiles)
    );
    const [counted] = await db
      .update(runs)
      .set({
        leaseUntil: null,
        pendingAttempts: sql`${runs.pendingAttempts} + 1`,
      })
      .where(waiting)
      .returning({ attempts: runs.pendingAttempts });
    if (!counted || counted.attempts < MAX_PENDING_ATTEMPTS) {
      return false;
    }
    const failed = await db
      .update(runs)
      .set({
        error: PENDING_FILES_ERROR,
        finishedAt: nowIso(),
        status: "failed",
      })
      .where(waiting)
      .returning({ id: runs.id });
    if (failed.length > 0) {
      await appendRunEvent(run, "run.failed", eventActor(SYSTEM_PRINCIPAL), {
        error: PENDING_FILES_ERROR,
      });
      await offerNextWaiting(run);
    }
    return true;
  };

  type DownloadOutcome = "downloaded" | "failed" | "skipped";

  /**
   * Takes the run's download lease, or says someone else holds it. The lease
   * rides on `lease_until`, which a queued run does not otherwise use.
   */
  const claimDownload = async (run: RunRecord): Promise<boolean> => {
    const now = nowIso();
    const claimed = await db
      .update(runs)
      .set({
        leaseUntil: new Date(
          clock.now().getTime() + DOWNLOAD_LEASE_MS
        ).toISOString(),
      })
      .where(
        and(
          eq(runs.id, run.id),
          inArray(runs.status, STARTING),
          isNotNull(runs.pendingFiles),
          or(isNull(runs.leaseUntil), lt(runs.leaseUntil, now))
        )
      )
      .returning({ id: runs.id });
    return claimed.length > 0;
  };

  /** Fetches a run's leftover Slack files through its reply gateway. */
  const downloadPendingFiles = async (
    run: RunRecord
  ): Promise<DownloadOutcome> => {
    const gateway = gatewayByKind.get(run.reply.kind);
    if (
      !(
        run.pendingFiles &&
        gateway?.downloadPendingFiles &&
        (await claimDownload(run))
      )
    ) {
      return "skipped";
    }
    let fileIds: string[];
    try {
      fileIds = await gateway.downloadPendingFiles(run.pendingFiles, {
        agentId: run.agentId,
        onBehalfOfUserId: run.onBehalfOfUserId,
        runId: run.id,
        workspaceId: run.workspaceId,
      });
    } catch (error) {
      if (await recordFailedDownload(run)) {
        return "failed";
      }
      throw error;
    }
    const stored = await db
      .update(runs)
      .set({
        inputFileIds: JSON.stringify([...run.inputFileIds, ...fileIds]),
        leaseUntil: null,
        pendingFiles: null,
      })
      .where(
        and(
          eq(runs.id, run.id),
          inArray(runs.status, STARTING),
          isNotNull(runs.pendingFiles)
        )
      )
      .returning({ id: runs.id });
    return stored.length > 0 ? "downloaded" : "skipped";
  };

  const offerRun = async (run: RunRecord): Promise<boolean> => {
    const { adapter, agent } = await adapterFor(run);
    if (!(agent && adapter)) {
      return false;
    }
    await adapter.dispatch(db, run, agent, adapterDeps);
    return true;
  };

  /**
   * Offers the agent's oldest waiting run as soon as one of its runs ends, for
   * a runtime that sets `offerNextOnEnd`. Its claim refuses the run while
   * another run of the agent still runs. The sweep is the backstop, so a
   * failure is logged and never thrown.
   */
  const offerNextWaiting = async (run: RunRecord): Promise<void> => {
    try {
      const { adapter } = await adapterFor(run);
      if (!adapter?.offerNextOnEnd) {
        return;
      }
      const oldest = (sessionOnly: boolean) =>
        db
          .select({ id: runs.id, pendingFiles: runs.pendingFiles })
          .from(runs)
          .where(
            and(
              sessionOnly
                ? eq(runs.sessionId, run.sessionId)
                : or(
                    eq(runs.agentId, run.agentId),
                    eq(runs.sessionId, run.sessionId)
                  ),
              eq(runs.workspaceId, run.workspaceId),
              inArray(runs.status, STARTING)
            )
          )
          .orderBy(asc(runs.createdAt), asc(runs.id))
          .limit(1);
      const [agentQueue, sessionQueue] = await Promise.all([
        oldest(false),
        oldest(true),
      ]);
      const offered = new Set<string>();
      for (const next of [agentQueue[0], sessionQueue[0]]) {
        // A run still downloading holds its queue's order.
        if (!next || next.pendingFiles || offered.has(next.id)) {
          continue;
        }
        offered.add(next.id);
        try {
          // biome-ignore lint/performance/noAwaitInLoops: offer each queue head once
          const waiting = await loadRun(db, next.id);
          if (waiting) {
            await offerRun(waiting);
          }
        } catch (error) {
          console.error(`Offering run ${next.id} failed:`, error);
        }
      }
    } catch (error) {
      console.error(
        `Offering the next run of agent ${run.agentId} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  /**
   * A download can land while a live run of the agent is ending, so the offer
   * above is refused and the run's own end offered before the files were in.
   * If the run is still waiting and the agent has no live run now, the claim
   * is free: offer the agent's next run again instead of leaving it to the
   * sweep.
   */
  const offerAgainIfFree = async (run: RunRecord): Promise<void> => {
    const [live] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          or(eq(runs.agentId, run.agentId), eq(runs.sessionId, run.sessionId)),
          inArray(runs.status, LIVE)
        )
      )
      .limit(1);
    const current = await loadRun(db, run.id);
    if (!live && current && STARTING.includes(current.status)) {
      await offerNextWaiting(current);
    }
  };

  /**
   * Tells the run's runtime that the reaper or the sweep ended the run, for a
   * runtime that has an `abandon`. A failure is logged and never thrown, so one
   * run cannot stop the job that is ending the others.
   */
  const abandonEnded = async (run: RunRecord): Promise<void> => {
    try {
      const adapter = await cleanupAdapter(run);
      await adapter?.abandon?.(run);
    } catch (error) {
      console.error(
        `Stopping the runtime of run ${run.id} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  /**
   * Offers one queued run to its agent's runtime, for the job a caller
   * defers until after it has answered (the sweep does it for a job that did
   * not run). A run still waiting on files is left alone.
   */
  const offerQueuedRun = async (
    principal: Principal,
    runId: string
  ): Promise<void> => {
    requireSystem(principal, "runs.offer");
    const run = await loadRun(db, runId);
    if (run && STARTING.includes(run.status) && !run.pendingFiles) {
      await offerRun(run);
    }
  };

  /**
   * Fetches the pending files of one run and offers it, for the Slack route's
   * `waitUntil` job (the sweep does the same for a job that did not finish).
   * A failed attempt throws; the third one fails the run and returns
   * "failed".
   */
  const fetchPendingFiles = async (
    principal: Principal,
    runId: string
  ): Promise<DownloadOutcome> => {
    requireSystem(principal, "runs.fetch_pending");
    const run = await loadRun(db, runId);
    if (!(run?.pendingFiles && STARTING.includes(run.status))) {
      return "skipped";
    }
    const outcome = await downloadPendingFiles(run);
    if (outcome === "downloaded") {
      const fetched = await loadRun(db, runId);
      if (fetched && STARTING.includes(fetched.status)) {
        await offerRun(fetched);
        await offerAgainIfFree(fetched);
      }
    }
    return outcome;
  };

  interface SweepResult {
    downloaded: string[];
    failed: { message: string; runId: string }[];
    offered: string[];
  }

  /** One stale run: fetch its files, then offer it again if it is claimable. */
  const sweepRun = async (row: RunRow, result: SweepResult) => {
    let run = toRecord(row);
    if (run.pendingFiles) {
      const outcome = await downloadPendingFiles(run);
      if (outcome === "failed") {
        result.failed.push({ message: PENDING_FILES_ERROR, runId: run.id });
        return;
      }
      if (outcome === "downloaded") {
        result.downloaded.push(run.id);
        run = (await loadRun(db, run.id)) ?? run;
      }
    }
    if (run.pendingFiles) {
      // Still downloading, so the run cannot be claimed yet.
      return;
    }
    if (await offerRun(run)) {
      result.offered.push(run.id);
    }
  };

  /**
   * Fails every run that nobody claimed within `UNCLAIMED_EXPIRY_MS`. A run
   * queued behind a `running` or `waiting` run of its agent is spared, and
   * the hour restarts when that run ends, so the agent gets the chance to
   * take it. The write is conditional on the starting statuses, so a claim
   * that wins is kept.
   */
  const expireUnclaimedRuns = async (
    expiryCutoff: string,
    result: SweepResult
  ) => {
    const busy = alias(runs, "busy");
    const expired = await db
      .select()
      .from(runs)
      .where(
        and(
          inArray(runs.status, STARTING),
          lt(runs.createdAt, expiryCutoff),
          notExists(
            db
              .select({ id: busy.id })
              .from(busy)
              .where(
                and(
                  or(
                    eq(busy.agentId, runs.agentId),
                    eq(busy.sessionId, runs.sessionId)
                  ),
                  isNotNull(busy.startedAt),
                  or(
                    inArray(busy.status, LIVE),
                    gte(busy.finishedAt, expiryCutoff)
                  )
                )
              )
          )
        )
      )
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(SWEEP_BATCH);
    for (const row of expired) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: compare-and-set per run, so a claim that wins is respected
        const moved = await db
          .update(runs)
          .set({
            error: NEVER_CLAIMED_ERROR,
            finishedAt: nowIso(),
            status: "failed",
          })
          .where(and(eq(runs.id, row.id), inArray(runs.status, STARTING)))
          .returning({ id: runs.id });
        if (moved.length > 0) {
          await appendRunEvent(
            toRecord(row),
            "run.failed",
            eventActor(SYSTEM_PRINCIPAL),
            { error: NEVER_CLAIMED_ERROR }
          );
          await abandonEnded(toRecord(row));
          await offerNextWaiting(toRecord(row));
          result.failed.push({ message: NEVER_CLAIMED_ERROR, runId: row.id });
        }
      } catch (error) {
        result.failed.push({
          message: error instanceof Error ? error.message : String(error),
          runId: row.id,
        });
      }
    }
  };

  /**
   * The minute tick's queue job: fails every run nobody claimed within an
   * hour, then offers again every younger run that has sat `queued` or
   * `offered` for over 60 seconds, after fetching its leftover files. An
   * offer is idempotent because the claim is a conditional write. It looks at
   * the least recently swept runs first, so runs it cannot move on do not hold
   * the window.
   */
  const sweepQueuedRuns = async (principal: Principal) => {
    requireSystem(principal, "runs.sweep");
    const nowMs = clock.now().getTime();
    const cutoff = new Date(nowMs - STALE_QUEUE_MS).toISOString();
    const expiryCutoff = new Date(nowMs - UNCLAIMED_EXPIRY_MS).toISOString();
    const result: SweepResult = { downloaded: [], failed: [], offered: [] };
    await expireUnclaimedRuns(expiryCutoff, result);
    const stale = await db
      .select()
      .from(runs)
      .where(
        and(
          inArray(runs.status, STARTING),
          lt(runs.createdAt, cutoff),
          gte(runs.createdAt, expiryCutoff)
        )
      )
      .orderBy(
        asc(sql`coalesce(${runs.sweptAt}, ${runs.createdAt})`),
        asc(runs.id)
      )
      .limit(SWEEP_BATCH);
    for (const row of stale) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one update per row, since D1 caps bound parameters at 100
        await db
          .update(runs)
          .set({ sweptAt: nowIso() })
          .where(and(eq(runs.id, row.id), inArray(runs.status, STARTING)));
        await sweepRun(row, result);
      } catch (error) {
        result.failed.push({
          message: error instanceof Error ? error.message : String(error),
          runId: row.id,
        });
      }
    }
    return result;
  };

  /**
   * The minute tick's lease job. A run whose lease passed becomes
   * `interrupted` and stays there: a lost heartbeat does not prove the
   * process stopped, so the run is never queued again.
   */
  const reapExpiredLeases = async (principal: Principal) => {
    requireSystem(principal, "runs.reap");
    const now = nowIso();
    const expired = await db
      .select()
      .from(runs)
      .where(and(inArray(runs.status, LIVE), lt(runs.leaseUntil, now)))
      .limit(SWEEP_BATCH);
    const interrupted: string[] = [];
    for (const row of expired) {
      // biome-ignore lint/performance/noAwaitInLoops: compare-and-set per run, so a heartbeat that wins is respected
      const moved = await db
        .update(runs)
        .set({ error: "Lease expired", finishedAt: now, status: "interrupted" })
        .where(
          and(
            eq(runs.id, row.id),
            inArray(runs.status, LIVE),
            lt(runs.leaseUntil, now)
          )
        )
        .returning({ id: runs.id });
      if (moved.length > 0) {
        await appendRunEvent(
          toRecord(row),
          "run.interrupted",
          eventActor(principal)
        );
        await abandonEnded(toRecord(row));
        await offerNextWaiting(toRecord(row));
        interrupted.push(row.id);
      }
    }
    return { interrupted };
  };

  const authorizeScopedRun = async (principal: Principal, runId: string) => {
    const run = await requireRun(principal, runId);
    if (
      principal.kind === "run" &&
      (principal.runId !== run.id || principal.agentId !== run.agentId)
    ) {
      throw guestUnavailable();
    }
    authorize(principal, READ_ACTION, {
      id: run.id,
      kind: RUN_KIND,
      workspaceId: run.workspaceId,
    });
    if (run.scopeArtifactId) {
      await adapterFor(run);
    }
  };

  const guestContext = async (principal: Principal, runId: string) => {
    requireSystem(principal, "runs.guestContext");
    await authorizeScopedRun(principal, runId);
    const run = await loadRun(db, runId);
    if (!run?.scopeArtifactId) {
      throw guestUnavailable();
    }
    const rows = (
      await eventsService.transcript(
        SYSTEM_PRINCIPAL,
        run.workspaceId,
        run.sessionId
      )
    )
      .filter((event) =>
        ["message.user", "message.assistant"].includes(event.type)
      )
      .slice(-32);
    const messages = await Promise.all(
      rows.map(async (event) => ({
        actor: event.actor,
        payload: await eventsService.readPayload(SYSTEM_PRINCIPAL, event),
        type: event.type,
      }))
    );
    await authorizeScopedRun(principal, runId);
    return JSON.stringify(messages).slice(-160_000);
  };

  const guestExecution = async (principal: Principal, runId: string) => {
    requireSystem(principal, "runs.guestExecution");
    const run = await loadRun(db, runId);
    if (!run?.scopeArtifactId || run.actor.kind !== "guest") {
      throw guestUnavailable();
    }
    if (!TERMINAL_STATUSES.includes(run.status)) {
      await authorizeScopedRun(principal, runId);
    }
    const agent = await findAgent(db, {
      id: run.agentId,
      workspaceId: run.workspaceId,
    });
    if (!agent) {
      throw guestUnavailable();
    }
    return { model: agent.model, name: agent.name, run };
  };

  const subagentCaller = async (principal: Principal, write = false) => {
    if (principal.kind !== "run") {
      throw new ForbiddenError("runs.subagents");
    }
    const parent = await requireRun(principal, principal.runId);
    authorize(principal, READ_ACTION, {
      id: parent.id,
      kind: RUN_KIND,
      workspaceId: parent.workspaceId,
    });
    if (parent.agentId !== principal.agentId || parent.scopeArtifactId) {
      throw new ForbiddenError("runs.subagents");
    }
    const agent = await findAgent(db, {
      id: parent.agentId,
      workspaceId: parent.workspaceId,
    });
    if (
      !(agent && LIVE.includes(parent.status)) ||
      (write && !agent.subagents)
    ) {
      throw new ForbiddenError("runs.subagents");
    }
    return { agent, parent };
  };

  const subagentUnavailable = async (
    agent: Awaited<ReturnType<typeof subagentCaller>>["agent"]
  ): Promise<string | undefined> => {
    if (
      agent.computerMachineId ||
      (agent.runtime === "cloud" &&
        cloudEnvironmentOf(agent.runtimeConfig) === "linux-vm")
    ) {
      return "Agents with a computer cannot start subagents yet, because they share one computer.";
    }
    if (agent.runtime === "machine") {
      const [machine] = await db
        .select({ capabilities: machines.capabilities })
        .from(machines)
        .where(
          and(
            eq(machines.id, agent.machineId ?? ""),
            eq(machines.workspaceId, agent.workspaceId)
          )
        )
        .limit(1);
      const features: unknown = machine
        ? JSON.parse(machine.capabilities).features
        : undefined;
      if (
        !hasDaemonFeature(
          Array.isArray(features)
            ? features
                .filter(
                  (feature): feature is string => typeof feature === "string"
                )
                .join(",")
            : undefined,
          FEATURE_PARALLEL_SUBAGENTS
        )
      ) {
        return "Update the agentum client on this machine to use subagents.";
      }
    }
  };

  const requireSubagentStart = async (principal: Principal) => {
    const caller = await subagentCaller(principal, true);
    const unavailable = await subagentUnavailable(caller.agent);
    if (unavailable) {
      throw new ServiceError("invalid", unavailable);
    }
    return caller;
  };

  const subagentLevelOf = async (run: RunRecord): Promise<number> => {
    let level = run.subagentLevel;
    let cursor = run;
    while (cursor.parentRunId) {
      // biome-ignore lint/performance/noAwaitInLoops: the bounded chain is traversed sequentially
      const parent = await loadRun(db, cursor.parentRunId, run.workspaceId);
      if (
        !parent ||
        cursor.subagentLevel === 0 ||
        parent.agentId !== run.agentId
      ) {
        break;
      }
      level = Math.max(level, parent.subagentLevel);
      cursor = parent;
    }
    return level;
  };

  const subagentTools = async (principal: Principal) => {
    if (principal.kind !== "run") {
      return;
    }
    try {
      const { parent, agent } = await subagentCaller(principal);
      if (await subagentUnavailable(agent)) {
        return;
      }
      if (!agent.subagents) {
        const [child] = await db
          .select({ id: runs.id })
          .from(runs)
          .where(
            and(
              eq(runs.parentRunId, parent.id),
              eq(runs.agentId, parent.agentId),
              sql`${runs.subagentLevel} > 0`
            )
          )
          .limit(1);
        return child ? { message: false, start: false } : undefined;
      }
      return {
        start:
          (await subagentLevelOf(parent)) < 2 && parent.depth < MAX_RUN_DEPTH,
      };
    } catch (error) {
      if (error instanceof ForbiddenError) {
        return;
      }
      throw error;
    }
  };

  const ownSubagent = async (principal: Principal, id: string) => {
    const { parent } = await subagentCaller(principal);
    const target = await loadRun(db, id, parent.workspaceId);
    if (target && (await reachesSubagentParent(target, parent))) {
      return target;
    }
    throw new ServiceError("not_found", "Subagent not found");
  };

  const startSubagent = async (
    principal: Principal,
    raw: {
      task: string;
      model: string;
      connectors?: string[];
      secrets?: string[];
      tools?: string[];
      requestId?: string;
    }
  ): Promise<RunSummary> => {
    const input = z
      .strictObject({
        connectors: z.array(z.string().min(1)).max(200).optional(),
        model: z.string().min(1).max(100),
        requestId: z.string().min(1).max(200).optional(),
        secrets: z.array(z.string().min(1)).max(200).optional(),
        task: z.string().min(1).max(100_000),
        tools: z.array(z.string().min(1)).max(500).optional(),
      })
      .parse(raw);
    const { parent, agent } = await requireSubagentStart(principal);
    const level = await subagentLevelOf(parent);
    if (level >= 2) {
      throw new ServiceError(
        "invalid",
        "Subagents can nest only two levels deep"
      );
    }
    if (input.requestId) {
      const existing = await loadRunByRequest(
        db,
        parent.workspaceId,
        input.requestId
      );
      if (existing) {
        if (
          existing.parentRunId !== parent.id ||
          existing.subagentLevel === 0 ||
          existing.agentId !== agent.id
        ) {
          throw new ServiceError(
            "conflict",
            "That requestId is already used by another request"
          );
        }
        return toSummary(existing);
      }
    }
    assertModelForRuntime(agent.runtime, input.model);
    const accessScope = await validateSubagentAccess(db, parent, input);
    const [parentSession] = await db
      .select({ origin: sessions.origin, private: sessions.private })
      .from(sessions)
      .where(
        and(
          eq(sessions.id, parent.sessionId),
          eq(sessions.workspaceId, parent.workspaceId)
        )
      )
      .limit(1);
    const started = await startRun(
      principal,
      {
        agentId: agent.id,
        input: { text: input.task },
        requestId: input.requestId,
        session: {
          origin: "mcp",
          private:
            parentSession?.private === true || parentSession?.origin === "ui",
        },
      },
      {
        subagent: {
          accessScope,
          level: level + 1,
          model: input.model,
        },
      }
    );
    return getRun(principal, started.runId);
  };

  const subagentStatus = async (
    principal: Principal,
    id: string,
    waitMs = 0
  ) => {
    await ownSubagent(principal, id);
    return waitForRun(principal, id, waitMs);
  };

  const messageSubagent = async (
    principal: Principal,
    id: string,
    text: string
  ) => {
    const run = await ownSubagent(principal, id);
    const { parent } = await requireSubagentStart(principal);
    const level = await subagentLevelOf(parent);
    if (level >= 2) {
      throw new ServiceError(
        "invalid",
        "Subagents can nest only two levels deep"
      );
    }
    const agent = await findAgent(db, {
      id: run.agentId,
      workspaceId: run.workspaceId,
    });
    if (!agent) {
      throw new ServiceError("not_found", "Agent not found");
    }
    assertModelForRuntime(agent.runtime, run.model ?? agent.model);
    const accessScope = await validateSubagentAccess(
      db,
      parent,
      run.accessScope ?? {}
    );
    const started = await startRun(
      principal,
      {
        agentId: run.agentId,
        input: { text },
        session: { origin: "mcp" },
      },
      {
        sessionId: run.sessionId,
        subagent: {
          accessScope,
          level: Math.max(level + 1, run.subagentLevel),
          model: run.model ?? agent.model,
        },
      }
    );
    return getRun(principal, started.runId);
  };

  const cancelSubagentTree = async (parent: RunRecord): Promise<void> => {
    const children = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.parentRunId, parent.id),
          eq(runs.agentId, parent.agentId),
          sql`${runs.subagentLevel} > 0`
        )
      );
    for (const row of children) {
      const child = toRecord(row);
      if (child.subagentLevel > 0 && ACTIVE.includes(child.status)) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: cancellation follows the bounded run tree
          await cancelRun(SYSTEM_PRINCIPAL, child.id);
        } catch (error) {
          if (!(error instanceof ServiceError && error.code === "conflict")) {
            console.error(`Cancelling subagent ${child.id} failed:`, error);
          }
          // A child that finished during cancellation still has its descendants checked.
          await cancelSubagentTree(child);
        }
      } else {
        await cancelSubagentTree(child);
      }
    }
  };

  const stopSubagent = async (principal: Principal, id: string) => {
    const run = await ownSubagent(principal, id);
    await cancelOwnedRun(
      run,
      principal.kind === "run"
        ? { id: principal.runId, kind: "run" }
        : eventActor(principal)
    );
  };

  const listSubagents = async (principal: Principal) => {
    const { parent, agent } = await subagentCaller(principal);
    const rows = await db
      .select()
      .from(runs)
      .where(sql`${runs.id} in (
        with recursive owned(id, hops) as (
          select id, 0 from runs where id = ${parent.id} and workspace_id = ${parent.workspaceId}
          union all
          select child.id, owned.hops + 1 from runs child indexed by runs_parent_idx
            join owned on child.parent_run_id = owned.id
            where child.workspace_id = ${parent.workspaceId} and child.agent_id = ${parent.agentId}
              and child.subagent_level > 0 and owned.hops < ${MAX_RUN_DEPTH}
        ) select id from owned where hops > 0
      )`)
      .orderBy(asc(runs.createdAt), asc(runs.id));
    return rows.map((row) => {
      const run = toRecord(row);
      return {
        ...toSummary(run),
        model: run.model ?? agent.model,
        summary: (run.resultText ?? run.inputText)
          .replace(/\s+/g, " ")
          .slice(0, 200),
      };
    });
  };

  return {
    authorizeScopedRun,
    cancelRun,
    claimRun,
    claimRunForMachine,
    completeRun,
    fetchPendingFiles,
    getRun,
    guestContext,
    guestExecution,
    guestReadiness: async (grant: GuestGrant, agentId: string) => {
      await guestReadiness(grant, agentId);
    },
    heartbeatRun,
    ingestRunEvents,
    listSubagents,
    markRunning,
    markWaiting,
    messageSubagent,
    offerQueuedRun,
    /**
     * Lets the composition root react to each run event after it is written,
     * such as the Slack status. A listener runs inside the request that wrote
     * the event, so it must be quick; one that throws is logged and does not
     * fail the write.
     */
    onEvent: eventsService.onAppend,
    reapExpiredLeases,
    recordDryRunSkip,
    releaseRun,
    resumeRequest,
    startForGuest,
    startRun,
    startSubagent,
    stopSubagent,
    subagentStatus,
    subagentTools,
    sweepQueuedRuns,
    waitForRun,
  };
};

export type RunsService = ReturnType<typeof createRunsService>;
