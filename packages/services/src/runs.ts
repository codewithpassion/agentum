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
import { events } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import { type AgentRuntime, taskFolderPath } from "@repo/db/shared";
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
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { CLOUD_LEASE_MS } from "./cloud/lease.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
import { payloadSchema } from "./events/payload.ts";
import { type Blobs, createEventsService } from "./events.ts";
import type { LibraryService } from "./library.ts";
import { MANAGED_LEASE_MS } from "./managed/types.ts";
import {
  importRunTokenKey,
  type RunTokenClaims,
  signRunToken,
} from "./run-tokens.ts";
import { createFakeRuntime } from "./runs/fake-runtime.ts";
import { noneGateway } from "./runs/gateways.ts";
import { claimForMachine } from "./runs/machine-claim.ts";
import {
  findSession,
  loadRun,
  loadRunByRequest,
  requireFiles,
} from "./runs/queries.ts";
import { type RunRow, toRecord, toSummary } from "./runs/records.ts";
import {
  type Actor,
  deriveSubject,
  eventActor,
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

export interface RunsServiceOptions {
  adapters: readonly RuntimeAdapter[];
  atomic: Atomic;
  blobs: Blobs;
  clock: Clock;
  db: Database;
  /** Registers the echo runtime for agents whose runtime is `fake`. */
  devFakeRuntime: boolean;
  gateways: readonly Gateway[];
  /**
   * The workspace library. A machine claim lists the conflict copies waiting
   * for the agent, and each new run gets its task folder. Without it, the claim
   * names no library paths and runs get no folder.
   */
  library?: Pick<LibraryService, "mkdir" | "pendingConflicts">;
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
  subject: Subject
): void => {
  // Two runs of one agent share an actor, so the run tree and the person
  // behind it tell them apart.
  if (
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

export const createRunsService = ({
  adapters,
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
  const eventsService = createEventsService({ blobs, db });
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
    if (principal.kind !== "user") {
      return;
    }
    const [visible] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          await visibleSessions(db, principal),
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
  ) =>
    eventsService.append({
      actor,
      agentId: run.agentId,
      payload,
      runId: run.id,
      sessionId: run.sessionId,
      type,
      workspaceId: run.workspaceId,
    });

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
  const authorizeRunWrite = (
    principal: Principal,
    run: RunRecord,
    action: string
  ) => {
    authorize(principal, action, {
      id: run.id,
      kind: RUN_KIND,
      workspaceId: run.workspaceId,
    });
    const allowed =
      principal.kind === "system" ||
      (principal.kind === "machine" && run.claimedBy === principal.machineId);
    if (!allowed) {
      throw new ForbiddenError(action);
    }
  };

  const adapterFor = async (run: RunRecord) => {
    const agent = await findAgent(db, {
      id: run.agentId,
      workspaceId: run.workspaceId,
    });
    // A dry run is on the cloud runtime for good, even when its agent moves.
    return {
      adapter: agent && adapterByKind.get(run.dryRun ? "cloud" : agent.runtime),
      agent,
    };
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

  type Prepared = Awaited<ReturnType<typeof prepareStart>>;

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
    const subject = await deriveSubject(db, principal, agent.id);
    const fileIds = [...new Set(input.input.fileIds)];
    if (fileIds.length > 0 && subject.onBehalfOfUserId === null) {
      throw new ServiceError("invalid", "This caller cannot attach files");
    }
    await requireFiles(db, {
      fileIds,
      ownerUserId: subject.onBehalfOfUserId ?? undefined,
      workspaceId: agent.workspaceId,
    });
    return { adapter, agent, fileIds, subject };
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

  /**
   * Writes the session (new, or its last-run time) and the run in one atomic
   * write. A duplicate `requestId` fails the unique index; the run that won is
   * read back and returned instead.
   */
  const insertOnce = async (
    prepared: Prepared,
    input: ParsedInput,
    options: StartRunOptions
  ): Promise<StartResult & { inserted: boolean }> => {
    const { agent, fileIds, subject } = prepared;
    const { workspaceId } = agent;
    const now = clock.now();
    const created = now.toISOString();
    const runId = ulid(now.getTime());
    const known = input.session.externalKey
      ? await findSession(db, {
          actor: subject.actor,
          agentId: agent.id,
          externalKey: input.session.externalKey,
          origin: input.session.origin,
          workspaceId,
        })
      : null;
    const sessionId = known?.id ?? ulid(now.getTime());
    const sessionWrite: Statement = known
      ? db
          .update(sessions)
          .set({ lastRunAt: created })
          .where(eq(sessions.id, known.id))
      : db.insert(sessions).values({
          actorId: subject.actor.id,
          actorKind: subject.actor.kind,
          agentId: agent.id,
          createdAt: created,
          // Without a key the session is its own key, so the UI can send the
          // next message to it by id.
          externalKey: input.session.externalKey ?? sessionId,
          id: sessionId,
          lastRunAt: created,
          origin: input.session.origin,
          private: input.session.private ?? false,
          workspaceId,
        });
    const runWrite = db.insert(runs).values({
      actorId: subject.actor.id,
      actorKind: subject.actor.kind,
      agentId: agent.id,
      createdAt: created,
      depth: subject.depth,
      dryRun: options.dryRun ?? false,
      id: runId,
      inputFileIds: JSON.stringify(fileIds),
      inputText: input.input.text,
      onBehalfOfUserId: subject.onBehalfOfUserId,
      outputFileIds: "[]",
      parentRunId: subject.parentRunId,
      pendingFiles: options.pendingFiles?.length
        ? JSON.stringify(options.pendingFiles)
        : null,
      reply: JSON.stringify(input.reply),
      requestId: input.requestId ?? null,
      sessionId,
      status: "queued",
      workspaceId,
    });
    try {
      await atomic([
        sessionWrite,
        runWrite,
        ...extraWrites(
          { agent, fileIds, input, runId, sessionId, subject },
          options
        ),
      ]);
      return { inserted: true, runId, sessionId, status: "queued" };
    } catch (error) {
      const existing =
        input.requestId && isUniqueViolation(error)
          ? await loadRunByRequest(db, workspaceId, input.requestId)
          : null;
      if (!existing) {
        throw error;
      }
      refuseForeignRequest(existing, agent.id, subject);
      return {
        inserted: false,
        runId: existing.id,
        sessionId: existing.sessionId,
        status: existing.status,
      };
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
    const { inserted, ...started } = await insertRun(prepared, input, options);
    if (inserted && options.dryRun !== true) {
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
      await prepared.adapter.dispatch(db, run, prepared.agent, adapterDeps);
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
  const claimRunForMachine = (
    principal: Principal,
    runId: string,
    options: {
      libraryForDaemon?: boolean;
      libraryLiveForDaemon?: boolean;
      requestsForDaemon?: boolean;
      platformUrl: string;
    }
  ): Promise<MachineClaim> =>
    claimForMachine(
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

  const claimRun = async (
    principal: Principal,
    runId: string,
    options?: { leaseMs?: number }
  ): Promise<RunRecord> => {
    requireSystem(principal, "runs.claim");
    const sibling = alias(runs, "sibling");
    const older = alias(runs, "older");
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
                  eq(sibling.agentId, runs.agentId),
                  inArray(sibling.status, LIVE)
                )
              )
          ),
          // A session's runs run in order: no older one may still be waiting.
          notExists(
            db
              .select({ id: older.id })
              .from(older)
              .where(
                and(
                  eq(older.sessionId, runs.sessionId),
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
    const moved = await db
      .update(runs)
      .set({ status: "waiting" })
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
      .returning({ id: runs.id });
    if (moved.length === 0) {
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
      .where(and(eq(runs.id, run.id), eq(runs.status, "waiting")))
      .returning({ id: runs.id });
    if (moved.length === 0) {
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
    authorizeRunWrite(principal, run, "runs.ingest");
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
      await eventsService.append({
        actor: agentActor(run),
        agentId: run.agentId,
        payload: masker ? masker.maskDeep(event.payload) : event.payload,
        runId: run.id,
        seq: event.seq,
        sessionId: run.sessionId,
        type: event.type,
        workspaceId: run.workspaceId,
      });
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
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
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
    authorizeRunWrite(principal, run, "runs.heartbeat");
    const extended = await db
      .update(runs)
      .set({
        // ISO 8601: the run token check compares lease_until as text.
        leaseUntil: new Date(
          clock.now().getTime() + (options?.leaseMs ?? LEASE_MS)
        ).toISOString(),
      })
      .where(and(eq(runs.id, run.id), inArray(runs.status, LIVE)))
      .returning({ id: runs.id });
    if (extended.length === 0) {
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
      .where(and(eq(runs.id, run.id), inArray(runs.status, LIVE)))
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
          exists(
            db
              .select({ id: runs.id })
              .from(runs)
              .where(and(eq(runs.id, run.id), inArray(runs.status, LIVE)))
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
    authorizeRunWrite(principal, run, "runs.complete");
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
        outputFileIds: JSON.stringify(fileIds),
        resultText: result.text ?? null,
        status: result.status,
        usage: result.usage ? JSON.stringify(result.usage) : null,
      })
      .where(and(eq(runs.id, run.id), inArray(runs.status, LIVE)));
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
    await appendRunEvent(run, "run.finished", agentActor(run), {
      outputFileIds: fileIds,
    });
    try {
      await deliverReply(run, { fileIds, text: result.text ?? "" });
    } finally {
      await offerNextWaiting(run);
    }
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
      run.parentRunId !== principal.runId
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
    const cancelled = await db
      .update(runs)
      .set({ finishedAt: nowIso(), status: "cancelled" })
      .where(and(eq(runs.id, run.id), inArray(runs.status, ACTIVE)))
      .returning({ id: runs.id });
    if (cancelled.length === 0) {
      throw new ServiceError("conflict", `Run is already ${run.status}`);
    }
    await appendRunEvent(run, "run.cancelled", eventActor(principal));
    const { adapter } = await adapterFor(run);
    await adapter?.cancel(db, run, adapterDeps);
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
      const [next] = await db
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.agentId, run.agentId),
            eq(runs.workspaceId, run.workspaceId),
            inArray(runs.status, STARTING),
            isNull(runs.pendingFiles)
          )
        )
        .orderBy(asc(runs.createdAt), asc(runs.id))
        .limit(1);
      if (!next) {
        return;
      }
      const waiting = await loadRun(db, next.id);
      if (waiting) {
        await offerRun(waiting);
      }
    } catch (error) {
      console.error(
        `Offering the next run of agent ${run.agentId} failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  /**
   * Tells the run's runtime that the reaper or the sweep ended the run, for a
   * runtime that has an `abandon`. A failure is logged and never thrown, so one
   * run cannot stop the job that is ending the others.
   */
  const abandonEnded = async (run: RunRecord): Promise<void> => {
    try {
      const { adapter } = await adapterFor(run);
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
                  eq(busy.agentId, runs.agentId),
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
        interrupted.push(row.id);
      }
    }
    return { interrupted };
  };

  return {
    cancelRun,
    claimRun,
    claimRunForMachine,
    completeRun,
    fetchPendingFiles,
    getRun,
    heartbeatRun,
    ingestRunEvents,
    markRunning,
    markWaiting,
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
    startRun,
    sweepQueuedRuns,
    waitForRun,
  };
};

export type RunsService = ReturnType<typeof createRunsService>;
