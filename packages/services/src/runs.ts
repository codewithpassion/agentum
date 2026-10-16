/**
 * Runs (contracts C3 and C7). Every way to make an agent do something goes
 * through `startRun`: it derives who is asking from the principal, finds or
 * creates the session, inserts a queued run and hands it to the agent's
 * runtime adapter. `ingestRunEvents` and `completeRun` are what the runtime
 * calls back with, fenced so that only a `running` run accepts them. The types
 * (adapters, gateways, the input schema) are in `@repo/services/runs/types`.
 */
import type { Database } from "@repo/db";
import type { Atomic, Statement } from "@repo/db/atomic";
import { events } from "@repo/db/schema/events";
import { runs } from "@repo/db/schema/runs";
import { sessions } from "@repo/db/schema/sessions";
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lt,
  max,
  or,
  sql,
} from "drizzle-orm";
import { ulid } from "ulidx";
import { z } from "zod";
import { findAgent } from "./agents.ts";
import { authorize, ForbiddenError } from "./authz.ts";
import { isUniqueViolation, ServiceError } from "./errors.ts";
import { payloadSchema } from "./events/payload.ts";
import { type Blobs, createEventsService } from "./events.ts";
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
import { visibleSessions } from "./sessions.ts";
import { type Principal, SYSTEM_PRINCIPAL } from "./workspaces.ts";

/** A claimed run is `running` until this long after the last heartbeat. */
export const LEASE_MS = 90_000;
/** A run still `queued` or `offered` after this long is offered again. */
export const STALE_QUEUE_MS = 60_000;
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

const STARTING: RunRecord["status"][] = ["queued", "offered"];
const ACTIVE: RunRecord["status"][] = ["queued", "offered", "running"];

const READ_ACTION = "runs.read";
const RUN_KIND = "run";

const runResultSchema = z.strictObject({
  error: z.string().max(10_000).optional(),
  fileIds: z.array(z.string().min(1).max(200)).max(100).optional(),
  runtimeRef: z.string().min(1).max(500).optional(),
  status: z.enum(["done", "failed", "aborted"]),
  text: z.string().max(1_000_000).optional(),
  usage: usageSchema.optional(),
});

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
   * `RUN_TOKEN_KEY` (base64, 32 bytes). Only the machine claim needs it, which
   * mints the run token; leave it out where no machine claims runs.
   */
  runTokenKey?: string;
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
  runTokenKey,
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
    return { adapter: agent && adapterByKind.get(agent.runtime), agent };
  };

  const adapterDeps: AdapterDeps = {
    claimRun: (principal, runId) => claimRun(principal, runId),
    clock,
    completeRun: (principal, runId, result) =>
      completeRun(principal, runId, result),
    ingestRunEvents: (principal, runId, batch) =>
      ingestRunEvents(principal, runId, batch),
  };

  type Prepared = Awaited<ReturnType<typeof prepareStart>>;

  /** Everything `startRun` checks before it writes. */
  const prepareStart = async (principal: Principal, input: ParsedInput) => {
    const agent = await findAgent(db, {
      id: input.agentId,
      workspaceId:
        principal.kind === "system" ? undefined : principal.workspaceId,
    });
    if (agent?.status !== "active") {
      throw new ServiceError("not_found", "Agent not found");
    }
    authorize(principal, START_ACTION, {
      kind: RUN_KIND,
      workspaceId: agent.workspaceId,
    });
    const adapter = adapterByKind.get(agent.runtime);
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
          workspaceId,
        });
    const runWrite = db.insert(runs).values({
      actorId: subject.actor.id,
      actorKind: subject.actor.kind,
      agentId: agent.id,
      createdAt: created,
      depth: subject.depth,
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
    const prepared = await prepareStart(principal, input);
    const { inserted, ...started } = await insertRun(prepared, input, options);
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
    options: { platformUrl: string }
  ): Promise<MachineClaim> =>
    claimForMachine(
      {
        announceStarted: async (run) => {
          await appendRunEvent(run, "run.started", agentActor(run));
        },
        db,
        leaseMs: LEASE_MS,
        now: () => clock.now(),
        signToken,
      },
      principal,
      runId,
      options
    );

  const claimRun = async (
    principal: Principal,
    runId: string
  ): Promise<RunRecord> => {
    requireSystem(principal, "runs.claim");
    const claimed = await db
      .update(runs)
      .set({
        claimedBy: "system",
        leaseUntil: new Date(clock.now().getTime() + LEASE_MS).toISOString(),
        startedAt: nowIso(),
        status: "running",
      })
      .where(
        and(
          eq(runs.id, runId),
          inArray(runs.status, STARTING),
          // A run with pending Slack files is not claimable.
          isNull(runs.pendingFiles)
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

  const ingestRunEvents = async (
    principal: Principal,
    runId: string,
    batch: readonly RunEventInput[]
  ): Promise<{ lastSeq: number }> => {
    const parsed = runEventsSchema.parse(batch);
    const run = await requireRun(principal, runId);
    authorizeRunWrite(principal, run, "runs.ingest");
    if (run.status !== "running") {
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
    for (const event of fresh) {
      // biome-ignore lint/performance/noAwaitInLoops: events are stored in seq order
      await eventsService.append({
        actor: agentActor(run),
        agentId: run.agentId,
        payload: event.payload,
        runId: run.id,
        seq: event.seq,
        sessionId: run.sessionId,
        type: event.type,
        workspaceId: run.workspaceId,
      });
      lastSeq = event.seq;
    }
    return { lastSeq };
  };

  /**
   * The daemon is still working: the lease moves to 90 seconds from now.
   * Refused with 409 unless the run is `running`. The write is conditional, so
   * a run the reaper just interrupted stays interrupted.
   */
  const heartbeatRun = async (
    principal: Principal,
    runId: string
  ): Promise<void> => {
    const run = await requireRun(principal, runId);
    authorizeRunWrite(principal, run, "runs.heartbeat");
    const extended = await db
      .update(runs)
      .set({
        // ISO 8601: the run token check compares lease_until as text.
        leaseUntil: new Date(clock.now().getTime() + LEASE_MS).toISOString(),
      })
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
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
    if (run.status !== "running") {
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
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
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
   * write applies only while the run is still `running`, and goes in the same
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
              .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
          )
        )
      );

  const completeRun = async (
    principal: Principal,
    runId: string,
    rawResult: RunResult
  ): Promise<void> => {
    const result = runResultSchema.parse(rawResult);
    const run = await requireRun(principal, runId);
    authorizeRunWrite(principal, run, "runs.complete");
    if (result.status === "aborted") {
      await abortedCompletion(principal, run);
      return;
    }
    if (run.status !== "running") {
      throw new ServiceError("conflict", `Run is ${run.status}, not running`);
    }
    const fileIds = [...new Set(result.fileIds ?? [])];
    await requireFiles(db, {
      fileIds,
      runId: run.id,
      workspaceId: run.workspaceId,
    });
    const failed = result.status === "failed";
    const error = failed ? (result.error ?? "Run failed") : null;
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
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")));
    // The session write goes first: it only applies while the run is running.
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
      await appendRunEvent(run, "run.failed", agentActor(run), { error });
      return;
    }
    await appendRunEvent(run, "run.finished", agentActor(run), {
      outputFileIds: fileIds,
    });
    await deliverReply(run, { fileIds, text: result.text ?? "" });
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
    // A user reads the runs of the sessions it can see, and a run of a hidden
    // session answers the same not-found as an unknown id.
    if (principal.kind === "user") {
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
    }
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
    const run = await requireRun(principal, runId);
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
   * The minute tick's queue job: offers again every run that has sat `queued`
   * or `offered` for over 60 seconds, after fetching its leftover files. An
   * offer is idempotent because the claim is a conditional write.
   */
  const sweepQueuedRuns = async (principal: Principal) => {
    requireSystem(principal, "runs.sweep");
    const cutoff = new Date(
      clock.now().getTime() - STALE_QUEUE_MS
    ).toISOString();
    const stale = await db
      .select()
      .from(runs)
      .where(and(inArray(runs.status, STARTING), lt(runs.createdAt, cutoff)))
      .orderBy(asc(runs.createdAt))
      .limit(SWEEP_BATCH);
    const result: SweepResult = { downloaded: [], failed: [], offered: [] };
    for (const row of stale) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one run at a time keeps a failure to that run
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
      .where(and(eq(runs.status, "running"), lt(runs.leaseUntil, now)))
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
            eq(runs.status, "running"),
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
    offerQueuedRun,
    reapExpiredLeases,
    startRun,
    sweepQueuedRuns,
    waitForRun,
  };
};

export type RunsService = ReturnType<typeof createRunsService>;
