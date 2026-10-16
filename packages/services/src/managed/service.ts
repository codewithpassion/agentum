/**
 * The Managed Agents runtime behind `ManagedRuntime.dispatch`. A `ManagedPoller`
 * (one Durable Object per run, woken by an alarm) calls `step` until it says
 * stop. A step is idempotent and driven by D1:
 *
 * 1. claim the run (`queued`/`offered` -> `running`), unless another run of its
 *    session is still running, because one Anthropic session takes one turn
 *    at a time;
 * 2. send the input: register or sync the Anthropic agent when its model,
 *    instructions or MCP servers changed, make a session with its own vault
 *    holding the session token, or send into the session that is already
 *    there;
 * 3. read the session's events, store the messages and tool calls as run
 *    events, move the lease, and when the session goes idle, complete the run.
 *
 * The session token (`hm_ses_`, see run-tokens.ts) is how a managed agent
 * reaches `/mcp` and the connector proxy: the MCP servers are fixed on the
 * Anthropic agent, so the credential rides per session in a vault.
 */
import type { Database } from "@repo/db";
import type { Atomic } from "@repo/db/atomic";
import { agentConnectors, connectors } from "@repo/db/schema/connectors";
import {
  managedAgents,
  managedRuns,
  managedSessions,
} from "@repo/db/schema/managed";
import { runs } from "@repo/db/schema/runs";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lt,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { type AgentRecord, findAgent } from "../agents.ts";
import { mcpServerUrls } from "../connectors/mcp-servers.ts";
import { hashToken } from "../crypto.ts";
import { isServiceError } from "../errors.ts";
import type { EventsService } from "../events.ts";
import { importRunTokenKey, signSessionToken } from "../run-tokens.ts";
import { loadRun } from "../runs/queries.ts";
import type { Clock, RunRecord } from "../runs/types.ts";
import type { RunsService } from "../runs.ts";
import { LEASE_MS } from "../runs.ts";
import { SYSTEM_PRINCIPAL } from "../workspaces.ts";
import { modelFor } from "./config.ts";
import { type EventCursor, isAbnormalStop, reduceEvents } from "./events.ts";
import type {
  IdCache,
  ManagedGateway,
  McpServerRef,
  PolledEvents,
} from "./gateway.ts";
import type { ManagedKeysService } from "./keys.ts";
import { finalReply, toRunEvents } from "./run-events.ts";
import type { ManagedPollerPort, ManagedStepResult } from "./types.ts";

/** How often a running run's session is read. */
export const POLL_MS = 2000;
/** The wait before trying a run that must wait for its session's previous run. */
export const BUSY_RETRY_MS = 5000;
/** Polls that fail in a row before the run fails. */
export const FAILURE_LIMIT = 5;
const MAX_BACKOFF_MS = 30_000;
/** A run still going after this long is stopped. */
export const RUN_MAX_MS = 60 * 60_000;
/** A session is not reused after this long, so its token does not live for ever. */
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
/** Anthropic holds 20 credentials per vault: the platform server and the connectors. */
export const MAX_SERVERS = 20;
/** `runs.claimed_by` of a run that Managed Agents is working on. */
export const MANAGED_CLAIMER = "managed";
const PAGE_SIZE = 500;

export const NO_KEY_ERROR =
  "This workspace has no Anthropic API key. Add one under Settings, Managed Agents.";
const NO_BASE_URL_ERROR =
  "PUBLIC_BASE_URL is not set, so the managed agent has no address to reach the platform at.";
const LOOPBACK_ERROR =
  "PUBLIC_BASE_URL points at this machine, which Anthropic cannot reach. Run a tunnel (cloudflared tunnel --config /dev/null --url http://localhost:<port>) and set PUBLIC_BASE_URL to its address.";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** An address only this machine can reach. Anthropic refuses to register one. */
const isLoopback = (url: string): boolean => {
  try {
    const { hostname } = new URL(url);
    return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
};

const STARTING: RunRecord["status"][] = ["queued", "offered"];
const DONE: ManagedStepResult = { next: null };

export interface ManagedServiceOptions {
  atomic: Atomic;
  clock: Clock;
  db: Database;
  events: EventsService;
  /** The gateway on one workspace's key. Tests give a fake. */
  gatewayFor: (key: { apiKey: string; environment: IdCache }) => ManagedGateway;
  keys: Pick<ManagedKeysService, "rememberEnvironment" | "resolve">;
  poller: ManagedPollerPort;
  /** `PUBLIC_BASE_URL`: where the Anthropic agent reaches `/mcp` and the proxy. */
  publicBaseUrl?: string;
  /** What the runs service lends. Lazy where the two services depend on each other. */
  runs: Pick<
    RunsService,
    "completeRun" | "heartbeatRun" | "ingestRunEvents" | "offerQueuedRun"
  >;
  /** `RUN_TOKEN_KEY`. Signs the session tokens. */
  runTokenKey?: string;
}

/** What went wrong, without anything the API might have echoed back. */
const describeError = (error: unknown): string => {
  if (isServiceError(error)) {
    return error.message;
  }
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === "number") {
    return `Anthropic answered ${status}`;
  }
  return error instanceof Error ? error.name : "unknown error";
};

const budgetMessage = "The session reached its spend limit";

const stopMessage = (stopReason: string | null, errors: string[]): string => {
  const base =
    stopReason === "budget_reached"
      ? budgetMessage
      : `The session stopped before it finished (${stopReason ?? "unknown"})`;
  return errors.length > 0 ? `${base}: ${errors.join("; ")}` : base;
};

export const createManagedService = ({
  atomic,
  clock,
  db,
  events,
  gatewayFor,
  keys,
  poller,
  publicBaseUrl,
  runs: runsApi,
  runTokenKey,
}: ManagedServiceOptions) => {
  const nowIso = () => clock.now().toISOString();

  let tokenKey: Promise<CryptoKey> | undefined;
  const sessionTokenKey = () => {
    if (!runTokenKey) {
      throw new Error("Managed sessions need runTokenKey (RUN_TOKEN_KEY).");
    }
    tokenKey ??= importRunTokenKey(runTokenKey);
    return tokenKey;
  };

  const failRun = async (run: RunRecord, error: string) => {
    try {
      await runsApi.completeRun(SYSTEM_PRINCIPAL, run.id, {
        error,
        status: "failed",
      });
    } catch (caught) {
      // Cancelled or finished meanwhile: the run is no longer ours to fail.
      if (!isServiceError(caught)) {
        throw caught;
      }
    }
  };

  /** Takes a starting run unless its session still has a run going. */
  const claim = async (run: RunRecord): Promise<boolean> => {
    const now = clock.now();
    const sibling = alias(runs, "sibling");
    const older = alias(runs, "older");
    const claimed = await db
      .update(runs)
      .set({
        claimedBy: MANAGED_CLAIMER,
        leaseUntil: new Date(now.getTime() + LEASE_MS).toISOString(),
        startedAt: now.toISOString(),
        status: "running",
      })
      .where(
        and(
          eq(runs.id, run.id),
          eq(runs.workspaceId, run.workspaceId),
          inArray(runs.status, STARTING),
          isNull(runs.pendingFiles),
          notExists(
            db
              .select({ id: sibling.id })
              .from(sibling)
              .where(
                and(
                  eq(sibling.sessionId, runs.sessionId),
                  eq(sibling.status, "running")
                )
              )
          ),
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
      return false;
    }
    await events.append({
      actor: { id: run.agentId, kind: "agent" },
      agentId: run.agentId,
      payload: {},
      runId: run.id,
      sessionId: run.sessionId,
      type: "run.started",
      workspaceId: run.workspaceId,
    });
    return true;
  };

  const gatewayOf = (
    workspaceId: string,
    key: { apiKey: string; environmentId: string | null }
  ) =>
    gatewayFor({
      apiKey: key.apiKey,
      environment: {
        read: () => Promise.resolve(key.environmentId),
        write: (id) => keys.rememberEnvironment(workspaceId, id),
      },
    });

  /** The servers the Anthropic agent connects to: the platform and the agent's connectors. */
  const serversOf = async (
    run: RunRecord,
    base: string
  ): Promise<McpServerRef[]> => {
    const assigned = await db
      .select({ id: connectors.id, name: connectors.name })
      .from(agentConnectors)
      .innerJoin(connectors, eq(connectors.id, agentConnectors.connectorId))
      .where(
        and(
          eq(agentConnectors.agentId, run.agentId),
          eq(agentConnectors.workspaceId, run.workspaceId)
        )
      )
      .orderBy(
        asc(agentConnectors.createdAt),
        asc(agentConnectors.connectorId)
      );
    return mcpServerUrls({ connectors: assigned, platformUrl: base });
  };

  const ensureRegistered = async ({
    agent,
    fingerprint,
    gateway,
    model,
    servers,
    system,
  }: {
    agent: AgentRecord;
    fingerprint: string;
    gateway: ManagedGateway;
    model: string;
    servers: McpServerRef[];
    system: string;
  }): Promise<string> => {
    const [row] = await db
      .select()
      .from(managedAgents)
      .where(eq(managedAgents.agentId, agent.id))
      .limit(1);
    const input = { mcpServers: servers, model, name: agent.name, system };
    if (!row) {
      const { anthropicAgentId } = await gateway.registerAgent({
        ...input,
        instructions: agent.instructions,
      });
      // Two sessions registering at once leave one orphan agent at Anthropic;
      // both use the row that won.
      await db
        .insert(managedAgents)
        .values({
          agentId: agent.id,
          anthropicAgentId,
          createdAt: nowIso(),
          fingerprint,
          syncedAt: nowIso(),
          workspaceId: agent.workspaceId,
        })
        .onConflictDoNothing();
      const [winner] = await db
        .select({ id: managedAgents.anthropicAgentId })
        .from(managedAgents)
        .where(eq(managedAgents.agentId, agent.id))
        .limit(1);
      return winner?.id ?? anthropicAgentId;
    }
    if (row.fingerprint !== fingerprint) {
      await gateway.syncAgent({
        ...input,
        anthropicAgentId: row.anthropicAgentId,
      });
      await db
        .update(managedAgents)
        .set({ fingerprint, syncedAt: nowIso() })
        .where(eq(managedAgents.agentId, agent.id));
    }
    return row.anthropicAgentId;
  };

  type SessionRow = typeof managedSessions.$inferSelect;

  const cursorOf = (session: SessionRow): EventCursor | undefined =>
    session.cursorEventId
      ? {
          lastEventId: session.cursorEventId,
          lastProcessedAt: session.cursorProcessedAt,
        }
      : undefined;

  const dropVault = async (gateway: ManagedGateway, vaultId: string) => {
    try {
      await gateway.deleteVault(vaultId);
    } catch (error) {
      console.error("Deleting a managed session vault failed:", error);
    }
  };

  /** Ends a session's life: it is never reused, and its token stops working. */
  const closeSession = async (
    session: Pick<SessionRow, "sessionId" | "vaultId">,
    gateway: ManagedGateway | null
  ) => {
    await db
      .update(managedSessions)
      .set({ closedAt: nowIso() })
      .where(
        and(
          eq(managedSessions.sessionId, session.sessionId),
          isNull(managedSessions.closedAt)
        )
      );
    if (gateway) {
      await dropVault(gateway, session.vaultId);
    }
  };

  const isReusable = (session: SessionRow | undefined, fingerprint: string) =>
    session !== undefined &&
    session.closedAt === null &&
    session.anthropicSessionId !== null &&
    session.agentFingerprint === fingerprint &&
    clock.now().getTime() - Date.parse(session.createdAt) < SESSION_MAX_AGE_MS;

  /**
   * Moves the cursor past whatever the session did that no run read, such as
   * the end of a run the reaper interrupted, so the new run starts clean.
   */
  const skipUnreadEvents = async (
    gateway: ManagedGateway,
    session: SessionRow,
    anthropicSessionId: string
  ) => {
    const unread = await gateway.pollEvents(
      anthropicSessionId,
      cursorOf(session)
    );
    if (unread.cursor) {
      await db
        .update(managedSessions)
        .set({
          cursorEventId: unread.cursor.lastEventId,
          cursorProcessedAt: unread.cursor.lastProcessedAt,
        })
        .where(eq(managedSessions.sessionId, session.sessionId));
    }
  };

  /** Makes the Anthropic session, with a vault that holds this session's token. */
  const createSession = async ({
    agent,
    anthropicAgentId,
    fingerprint,
    gateway,
    model,
    run,
    servers,
    text,
  }: {
    agent: AgentRecord;
    anthropicAgentId: string;
    fingerprint: string;
    gateway: ManagedGateway;
    model: string;
    run: RunRecord;
    servers: McpServerRef[];
    text: string;
  }) => {
    const issuedAt = clock.now().getTime();
    const token = await signSessionToken(await sessionTokenKey(), {
      agentId: agent.id,
      issuedAt,
      sessionId: run.sessionId,
      workspaceId: run.workspaceId,
    });
    const vaultId = await gateway.createVault({
      displayName: `harbourmaster ${run.sessionId}`,
    });
    try {
      for (const server of servers) {
        // biome-ignore lint/performance/noAwaitInLoops: Anthropic takes the credentials of one vault one at a time
        await gateway.createBearerCredential({
          displayName: server.name,
          mcpServerUrl: server.url,
          token,
          vaultId,
        });
      }
      // The row goes in before the session exists: the agent may call a tool
      // the moment the session starts, and the token is checked against it.
      const values = {
        agentFingerprint: fingerprint,
        anthropicSessionId: null,
        closedAt: null,
        createdAt: nowIso(),
        cursorEventId: null,
        cursorProcessedAt: null,
        tokenIssuedAt: issuedAt,
        vaultId,
      };
      await db
        .insert(managedSessions)
        .values({
          ...values,
          sessionId: run.sessionId,
          workspaceId: run.workspaceId,
        })
        .onConflictDoUpdate({ set: values, target: managedSessions.sessionId });
      const created = await gateway.createSession({
        anthropicAgentId,
        model,
        text,
        title: agent.name,
        vaultIds: [vaultId],
      });
      await db
        .update(managedSessions)
        .set({ anthropicSessionId: created.sessionId })
        .where(eq(managedSessions.sessionId, run.sessionId));
    } catch (error) {
      await dropVault(gateway, vaultId);
      throw error;
    }
  };

  /** What the agent is told: the run's input, and a plain word about files it cannot get. */
  const messageOf = (run: RunRecord): string =>
    run.inputFileIds.length === 0
      ? run.inputText
      : `${run.inputText}\n\n[${run.inputFileIds.length} attached file(s) could not be passed to you: managed agents cannot read Harbourmaster files. Say so if you need what was in them.]`;

  /** Sends the run's input to Anthropic. Returns false when the run was failed instead. */
  const launch = async (
    run: RunRecord,
    agent: AgentRecord
  ): Promise<boolean> => {
    const key = await keys.resolve(run.workspaceId);
    if (!key) {
      await failRun(run, NO_KEY_ERROR);
      return false;
    }
    if (!publicBaseUrl) {
      await failRun(run, NO_BASE_URL_ERROR);
      return false;
    }
    if (isLoopback(publicBaseUrl)) {
      await failRun(run, LOOPBACK_ERROR);
      return false;
    }
    const servers = await serversOf(run, publicBaseUrl);
    if (servers.length > MAX_SERVERS) {
      await failRun(
        run,
        `A managed agent reaches at most ${MAX_SERVERS - 1} connectors, and this one has ${servers.length - 1}.`
      );
      return false;
    }
    const gateway = gatewayOf(run.workspaceId, key);
    const model = modelFor(agent.model);
    const system = agent.instructions.trim() || `You are ${agent.name}.`;
    const fingerprint = await hashToken(
      JSON.stringify({ model, name: agent.name, servers, system })
    );
    const anthropicAgentId = await ensureRegistered({
      agent,
      fingerprint,
      gateway,
      model,
      servers,
      system,
    });
    const [session] = await db
      .select()
      .from(managedSessions)
      .where(eq(managedSessions.sessionId, run.sessionId))
      .limit(1);
    const text = messageOf(run);
    if (
      session?.anthropicSessionId &&
      isReusable(session, fingerprint) &&
      (await gateway.getSession(session.anthropicSessionId)) === "idle"
    ) {
      await skipUnreadEvents(gateway, session, session.anthropicSessionId);
      await gateway.sendMessage(session.anthropicSessionId, text);
    } else {
      if (session) {
        await closeSession(session, gateway);
      }
      await createSession({
        agent,
        anthropicAgentId,
        fingerprint,
        gateway,
        model,
        run,
        servers,
        text,
      });
    }
    await db
      .update(managedRuns)
      .set({ sentAt: nowIso() })
      .where(eq(managedRuns.runId, run.id));
    return true;
  };

  /** The next run waiting in this session, if any, is offered now. */
  const offerNext = async (run: RunRecord) => {
    const [next] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.sessionId, run.sessionId),
          inArray(runs.status, STARTING),
          isNull(runs.pendingFiles)
        )
      )
      .orderBy(asc(runs.createdAt), asc(runs.id))
      .limit(1);
    if (next) {
      await runsApi.offerQueuedRun(SYSTEM_PRINCIPAL, next.id);
    }
  };

  const endFailed = async (
    run: RunRecord,
    session: SessionRow,
    gateway: ManagedGateway,
    error: string
  ) => {
    // Whatever the session was doing is unknown, so it is never reused.
    await closeSession(session, gateway);
    await failRun(run, error);
    await offerNext(run);
  };

  /** Stores what the session did since the last read, and moves the lease. */
  const storeProgress = async (
    run: RunRecord,
    session: SessionRow,
    managedRun: typeof managedRuns.$inferSelect,
    polled: PolledEvents
  ) => {
    const mapped = toRunEvents(polled.events, managedRun.nextSeq);
    for (let from = 0; from < mapped.events.length; from += PAGE_SIZE) {
      // biome-ignore lint/performance/noAwaitInLoops: pages are stored in seq order
      await runsApi.ingestRunEvents(
        SYSTEM_PRINCIPAL,
        run.id,
        mapped.events.slice(from, from + PAGE_SIZE)
      );
    }
    const cursor = polled.cursor ?? cursorOf(session);
    await atomic([
      db
        .update(managedRuns)
        .set({ failures: 0, nextSeq: mapped.nextSeq })
        .where(eq(managedRuns.runId, run.id)),
      db
        .update(managedSessions)
        .set({
          cursorEventId: cursor ? cursor.lastEventId : null,
          cursorProcessedAt: cursor ? cursor.lastProcessedAt : null,
        })
        .where(eq(managedSessions.sessionId, session.sessionId)),
    ]);
    await runsApi.heartbeatRun(SYSTEM_PRINCIPAL, run.id);
  };

  /** Whether the session finished the turn, and how. */
  const settle = async (
    run: RunRecord,
    session: SessionRow,
    gateway: ManagedGateway,
    polled: PolledEvents
  ): Promise<ManagedStepResult> => {
    const outcome = reduceEvents(polled.events, "running");
    const stopped =
      outcome.status === "terminated" ||
      (outcome.status === "idle" && isAbnormalStop(outcome.stopReason));
    if (stopped) {
      const reason =
        outcome.status === "terminated" ? "terminated" : outcome.stopReason;
      await endFailed(
        run,
        session,
        gateway,
        stopMessage(reason, outcome.errors)
      );
      return DONE;
    }
    if (outcome.status === "idle") {
      const text = await finalReply(db, run);
      await runsApi.completeRun(SYSTEM_PRINCIPAL, run.id, {
        status: "done",
        text,
      });
      await offerNext(run);
      return DONE;
    }
    const age =
      clock.now().getTime() - Date.parse(run.startedAt ?? run.createdAt);
    if (age > RUN_MAX_MS && session.anthropicSessionId) {
      await gateway.interrupt(session.anthropicSessionId);
      await endFailed(run, session, gateway, "The run took too long");
      return DONE;
    }
    return { next: POLL_MS };
  };

  /** Reads the session once. Returns what the step answers. */
  const poll = async (run: RunRecord): Promise<ManagedStepResult> => {
    const [[session], [managedRun], key] = await Promise.all([
      db
        .select()
        .from(managedSessions)
        .where(eq(managedSessions.sessionId, run.sessionId))
        .limit(1),
      db
        .select()
        .from(managedRuns)
        .where(eq(managedRuns.runId, run.id))
        .limit(1),
      keys.resolve(run.workspaceId),
    ]);
    if (!(key && managedRun)) {
      await failRun(run, NO_KEY_ERROR);
      return DONE;
    }
    if (!session?.anthropicSessionId || session.closedAt) {
      await failRun(run, "The Anthropic session is gone");
      await offerNext(run);
      return DONE;
    }
    const gateway = gatewayOf(run.workspaceId, key);
    const polled = await gateway.pollEvents(
      session.anthropicSessionId,
      cursorOf(session)
    );
    await storeProgress(run, session, managedRun, polled);
    return await settle(run, session, gateway, polled);
  };

  const countFailure = async (run: RunRecord): Promise<ManagedStepResult> => {
    const [counted] = await db
      .update(managedRuns)
      .set({ failures: sql`${managedRuns.failures} + 1` })
      .where(eq(managedRuns.runId, run.id))
      .returning({ failures: managedRuns.failures });
    const failures = counted?.failures ?? FAILURE_LIMIT;
    if (failures >= FAILURE_LIMIT) {
      return DONE;
    }
    return { next: Math.min(MAX_BACKOFF_MS, BUSY_RETRY_MS * failures) };
  };

  /** One run, running: send its input if that is not done yet, then read its session. */
  const work = async (
    run: RunRecord,
    agent: AgentRecord
  ): Promise<ManagedStepResult> => {
    const [managedRun] = await db
      .select()
      .from(managedRuns)
      .where(eq(managedRuns.runId, run.id))
      .limit(1);
    if (!(managedRun?.sentAt || (await launch(run, agent)))) {
      return DONE;
    }
    return await poll(run);
  };

  /**
   * The run and its agent once the run is running, or the answer when there is
   * nothing to work on yet: finished, not a managed run, or waiting its turn.
   */
  const prepare = async (
    runId: string
  ): Promise<
    { agent: AgentRecord; run: RunRecord } | { answer: ManagedStepResult }
  > => {
    let run = await loadRun(db, runId);
    const agent = run
      ? await findAgent(db, { id: run.agentId, workspaceId: run.workspaceId })
      : null;
    if (!(run && agent) || agent.runtime !== "managed") {
      return { answer: DONE };
    }
    await db
      .insert(managedRuns)
      .values({
        createdAt: nowIso(),
        runId: run.id,
        workspaceId: run.workspaceId,
      })
      .onConflictDoNothing();
    if (STARTING.includes(run.status)) {
      await claim(run);
      // Reloaded either way: a claim that lost may still find the run running.
      run = await loadRun(db, runId);
      if (run && STARTING.includes(run.status)) {
        return { answer: { next: BUSY_RETRY_MS } };
      }
    }
    return run?.status === "running" ? { agent, run } : { answer: DONE };
  };

  const step = async (runId: string): Promise<ManagedStepResult> => {
    const ready = await prepare(runId);
    if ("answer" in ready) {
      return ready.answer;
    }
    const { agent, run } = ready;
    try {
      return await work(run, agent);
    } catch (error) {
      if (isServiceError(error)) {
        // The run was cancelled, finished or reaped between two writes.
        const latest = await loadRun(db, runId);
        if (latest?.status !== "running") {
          return DONE;
        }
      }
      console.error(
        `Managed run ${runId} step failed: ${describeError(error)}`
      );
      const result = await countFailure(run);
      if (result.next === null) {
        await failRun(
          run,
          `Anthropic could not be reached: ${describeError(error)}`
        );
        await offerNext(run);
      }
      return result;
    }
  };

  /**
   * A run was cancelled: its session is closed so the stale idle it leaves
   * behind is never taken for the next run's, and Anthropic is told to stop.
   */
  const interrupt = async (runId: string): Promise<void> => {
    const run = await loadRun(db, runId);
    if (!run) {
      return;
    }
    const [[session], key] = await Promise.all([
      db
        .select()
        .from(managedSessions)
        .where(eq(managedSessions.sessionId, run.sessionId))
        .limit(1),
      keys.resolve(run.workspaceId),
    ]);
    if (!(session?.anthropicSessionId && key) || session.closedAt) {
      return;
    }
    const gateway = gatewayOf(run.workspaceId, key);
    await closeSession(session, gateway);
    await gateway.interrupt(session.anthropicSessionId);
  };

  /**
   * The minute tick: wakes the poller of every managed run that is running, in
   * case its alarm was lost. A poller that is already armed ignores the nudge.
   */
  const rearm = async (): Promise<{ kicked: string[] }> => {
    const active = await db
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(eq(runs.status, "running"), eq(runs.claimedBy, MANAGED_CLAIMER))
      )
      .limit(100);
    const kicked: string[] = [];
    for (const { id } of active) {
      try {
        // biome-ignore lint/performance/noAwaitInLoops: one nudge per run keeps a slow poller from holding the others
        await poller.kick(id);
        kicked.push(id);
      } catch (error) {
        console.error(`Waking the poller for run ${id} failed:`, error);
      }
    }
    return { kicked };
  };

  return { interrupt, rearm, step };
};

export type ManagedService = ReturnType<typeof createManagedService>;
