import { DurableObject } from "cloudflare:workers";
import { createDb, type Db } from "#/db/client";
import type { Agent } from "#/modules/agents/schema";
import {
  type AgentStatus,
  getAgentById,
  listAgents,
  setAgentRuntimeStatus,
} from "#/modules/agents/service";
import {
  isSessionReusable,
  reduceEvents,
  type SessionStatus,
} from "#/modules/anthropic/events";
import type { AnthropicGateway } from "#/modules/anthropic/gateway";
import {
  createGateway,
  isAnthropicEnabled,
  resyncAgentConnectorsWithAnthropic,
  sessionVaultIdsFor,
} from "#/modules/anthropic/service";
import { recordConnectorAuthFailure } from "#/modules/connectors/service";
import { broadcastChannelEvent } from "#/modules/messaging/realtime";
import {
  DIGEST_INTERVAL_MS,
  DIGEST_MAX_ENTRIES,
  PUMP_INTERVAL_MS,
  SESSION_IDLE_TTL_MS,
} from "./config";
import {
  type ChannelGuard,
  checkWakeRate,
  emptyChannelGuard,
  nextChannelGuard,
} from "./loop-guard";
import { freeSlots, planWakes } from "./plan";
import {
  DIGEST_KEY,
  GUARD_KEY,
  NEXT_DIGEST_KEY,
  PENDING_KEY,
  type PendingNotification,
  QUEUE_KEY,
  type QueuedWake,
  RATE_KEY,
  SESSION_KEY,
  SESSION_KEY_PREFIX,
  type StoredSession,
} from "./state";
import { decideWakes, type MessageNotification } from "./wake-decision";
import {
  composeDigestWake,
  composeImmediateWake,
  type WakeEntry,
} from "./wake-text";

/**
 * The single global router (`idFromName("router")`). Every message published
 * anywhere in the workspace is announced to it; it decides who wakes, owns the
 * Anthropic sessions, and pumps their events back out as agent status.
 *
 * `notifyMessage` does only the cheap, ordered part - loop guard and wake
 * decision - and hands the rest to an alarm, so posting a message never waits
 * on the Anthropic API.
 */

const ROUTER_NAME = "router";

export const routerStub = (env: Env) =>
  env.AGENT_ROUTER.get(env.AGENT_ROUTER.idFromName(ROUTER_NAME));

const toWakeEntry = (notification: MessageNotification): WakeEntry => ({
  authorName: notification.authorName,
  body: notification.body,
  channelId: notification.channelId,
  channelKind: notification.channelKind,
  channelName: notification.channelName,
  createdAt: notification.createdAt,
  messageId: notification.messageId,
  threadParentId: notification.threadParentId,
});

export class AgentRouter extends DurableObject<Env> {
  private database: Db | null = null;

  private get db(): Db {
    this.database ??= createDb(this.env.DB);
    return this.database;
  }

  private gateway(): AnthropicGateway | null {
    return createGateway(this.db, this.env);
  }

  private read<T>(key: string): Promise<T | undefined> {
    return this.ctx.storage.get<T>(key);
  }

  private write(key: string, value: unknown): Promise<void> {
    return this.ctx.storage.put(key, value);
  }

  // --- inbound ---------------------------------------------------------------

  /**
   * Called from `publishMessage` after every message create. Returns as soon as
   * the decision is recorded; the alarm does the talking to Anthropic.
   */
  async notifyMessage(notification: MessageNotification): Promise<void> {
    if (!isAnthropicEnabled(this.env)) {
      return;
    }

    const guardKey = GUARD_KEY(notification.channelId);
    const previous =
      (await this.read<ChannelGuard>(guardKey)) ?? emptyChannelGuard();
    const guard = nextChannelGuard(previous, notification.authorType);
    await this.write(guardKey, guard);

    if (guard.suppressed && !previous.suppressed) {
      await broadcastChannelEvent(this.env, {
        channelId: notification.channelId,
        type: "router.suppressed",
      });
    }

    const targets = decideWakes(notification);
    if (targets.length === 0) {
      return;
    }

    const pending = (await this.read<PendingNotification[]>(PENDING_KEY)) ?? [];
    pending.push({ entry: toWakeEntry(notification), targets });
    await this.write(PENDING_KEY, pending);
    await this.ctx.storage.setAlarm(Date.now());
  }

  // --- alarm -----------------------------------------------------------------

  override async alarm(): Promise<void> {
    await this.dispatchPending();
    await this.pumpSessions();
    await this.flushDigests();
    await this.drainQueue();
    await this.scheduleNextAlarm();
  }

  private async dispatchPending(): Promise<void> {
    const pending = (await this.read<PendingNotification[]>(PENDING_KEY)) ?? [];
    if (pending.length === 0) {
      return;
    }
    await this.write(PENDING_KEY, []);

    for (const item of pending) {
      // In order: each message's plan depends on the sessions the ones before
      // it started, so these cannot overlap.
      // biome-ignore lint/performance/noAwaitInLoops: messages must be dispatched in the order they were posted
      await this.dispatchOne(item);
    }
  }

  private async dispatchOne(item: PendingNotification): Promise<void> {
    const now = Date.now();
    const guard =
      (await this.read<ChannelGuard>(GUARD_KEY(item.entry.channelId))) ??
      emptyChannelGuard();

    const sessions = new Map<string, StoredSession | null>();
    const rates = new Map<string, number[]>();
    for (const target of item.targets) {
      // Durable Object storage reads are local; a handful in sequence is
      // cheaper than the bookkeeping to parallelise them.
      // biome-ignore lint/performance/noAwaitInLoops: local Durable Object storage reads
      sessions.set(target.agentId, await this.liveSession(target.agentId, now));
      rates.set(
        target.agentId,
        (await this.read<number[]>(RATE_KEY(target.agentId))) ?? []
      );
    }

    const planned = planWakes({
      activeSessions: await this.countActiveSessions(),
      hasLiveSession: (agentId) => Boolean(sessions.get(agentId)),
      isWithinRate: (agentId) =>
        checkWakeRate(rates.get(agentId) ?? [], now).allowed,
      suppressed: guard.suppressed,
      targets: item.targets,
    });

    for (const { action, agentId } of planned) {
      if (action === "suppressed") {
        continue;
      }
      if (action === "digest") {
        // One agent at a time: each wake consumes a session slot the next one
        // has to plan around.
        // biome-ignore lint/performance/noAwaitInLoops: session slots are taken one wake at a time
        await this.appendDigest(agentId, item.entry);
        continue;
      }
      const entries = [...(await this.takeDigest(agentId)), item.entry];
      if (action === "queue") {
        await this.enqueue(agentId, entries, now);
        continue;
      }
      await this.spendWake(agentId, rates.get(agentId) ?? [], now);
      await this.wake(agentId, entries, sessions.get(agentId) ?? null).catch(
        () => {
          // The failure is already on the agent's status; retrying here would
          // just burn the same call again.
        }
      );
    }
  }

  /** Sends into a live session, or starts one. Either way the agent is working. */
  private async wake(
    agentId: string,
    entries: readonly WakeEntry[],
    session: StoredSession | null
  ): Promise<void> {
    const gateway = this.gateway();
    const agent = await getAgentById(this.db, agentId);
    const [first] = entries;
    const channelId = first?.channelId ?? session?.channelId ?? "";

    if (!(gateway && agent?.anthropicAgentId)) {
      // Nothing to wake - the agent was never registered, or the integration is
      // off. Clearing the status matters: it may have been queued to get here.
      await this.setStatus(agentId, "idle", channelId, null);
      return;
    }

    const text =
      entries.length === 1 && first
        ? composeImmediateWake(first)
        : composeDigestWake(entries);

    try {
      if (session) {
        await this.sendIntoSession(agent, session, text, channelId);
        return;
      }
      // The last moment a connector change can still reach this agent: the
      // vaults and the `mcp_servers` array are both fixed once the session
      // exists. It is also the retry for a resync that failed while idle.
      await this.startSession(
        await this.settleConnectors(agent),
        text,
        channelId
      );
    } catch (error) {
      await this.ctx.storage.delete(SESSION_KEY(agentId));
      await this.setStatus(agentId, "error", channelId, null);
      throw error;
    }
  }

  private async sendIntoSession(
    agent: Agent,
    session: StoredSession,
    text: string,
    channelId: string
  ): Promise<void> {
    const gateway = this.gateway();
    if (!gateway) {
      return;
    }
    try {
      await gateway.sendMessage(session.sessionId, text);
    } catch {
      // A live session can still refuse new work - it hit its budget cap, or it
      // terminated between our last poll and now. A fresh session always works.
      await this.ctx.storage.delete(SESSION_KEY(agent.id));
      await this.startSession(agent, text, channelId);
      return;
    }
    await this.write(SESSION_KEY(agent.id), {
      ...session,
      channelId,
      lastActivityAt: Date.now(),
      status: "running",
    } satisfies StoredSession);
    await this.setStatus(agent.id, "working", channelId, session.sessionId);
  }

  /**
   * Pays off a deferred connector resync while the agent provably has no
   * session. Best effort: if it fails the flag stays and the session starts on
   * the configuration the agent already has.
   *
   * The row's `sessionId` is the gate, and it can lag by one alarm - a session
   * retired by `liveSession` is only nulled out when the pump reaches it - so a
   * wake in that window defers again and lands on the next session instead.
   * That is the behaviour the UI promises for assignments anyway.
   */
  private async settleConnectors(agent: Agent): Promise<Agent> {
    if (!agent.connectorResyncPendingAt) {
      return agent;
    }
    await resyncAgentConnectorsWithAnthropic(this.db, this.env, agent.id).catch(
      () => {
        // Recorded on the agent's sync status.
      }
    );
    return (await getAgentById(this.db, agent.id)) ?? agent;
  }

  private async startSession(
    agent: Agent,
    text: string,
    channelId: string
  ): Promise<void> {
    const gateway = this.gateway();
    if (!(gateway && agent.anthropicAgentId)) {
      return;
    }
    const created = await gateway.createSession({
      anthropicAgentId: agent.anthropicAgentId,
      memoryStoreId: agent.memoryStoreId,
      text,
      title: `${agent.name} in ${channelId}`,
      // Create-only on Anthropic's side: this is the one moment the agent's
      // connector credentials can be attached to the session.
      vaultIds: await sessionVaultIdsFor(this.db, agent.id),
    });
    await this.write(SESSION_KEY(agent.id), {
      channelId,
      cursorAt: null,
      cursorId: null,
      lastActivityAt: Date.now(),
      sessionId: created.sessionId,
      status: created.status,
    } satisfies StoredSession);
    await this.setStatus(agent.id, "working", channelId, created.sessionId);
  }

  // --- digests ---------------------------------------------------------------

  private async appendDigest(agentId: string, entry: WakeEntry): Promise<void> {
    const entries = (await this.read<WakeEntry[]>(DIGEST_KEY(agentId))) ?? [];
    entries.push(entry);
    await this.write(DIGEST_KEY(agentId), entries.slice(-DIGEST_MAX_ENTRIES));
    await this.armDigest();
  }

  private async armDigest(): Promise<void> {
    if ((await this.read<number>(NEXT_DIGEST_KEY)) === undefined) {
      await this.write(NEXT_DIGEST_KEY, Date.now() + DIGEST_INTERVAL_MS);
    }
  }

  private async takeDigest(agentId: string): Promise<WakeEntry[]> {
    const entries = (await this.read<WakeEntry[]>(DIGEST_KEY(agentId))) ?? [];
    if (entries.length > 0) {
      await this.ctx.storage.delete(DIGEST_KEY(agentId));
    }
    return entries;
  }

  /** One combined wake per agent, for everything queued since the last flush. */
  private async flushDigests(): Promise<void> {
    const dueAt = await this.read<number>(NEXT_DIGEST_KEY);
    if (dueAt === undefined || Date.now() < dueAt) {
      return;
    }
    await this.ctx.storage.delete(NEXT_DIGEST_KEY);

    const now = Date.now();
    for (const agent of await listAgents(this.db)) {
      // biome-ignore lint/performance/noAwaitInLoops: session slots are taken one wake at a time
      const entries = await this.read<WakeEntry[]>(DIGEST_KEY(agent.id));
      if (!entries || entries.length === 0) {
        continue;
      }

      const window = (await this.read<number[]>(RATE_KEY(agent.id))) ?? [];
      if (!checkWakeRate(window, now).allowed) {
        // Out of budget: the digest waits for the next interval rather than
        // being dropped.
        await this.armDigest();
        continue;
      }

      const session = await this.liveSession(agent.id, now);
      await this.ctx.storage.delete(DIGEST_KEY(agent.id));

      if (!(session || freeSlots(await this.countActiveSessions()) > 0)) {
        await this.enqueue(agent.id, entries, now);
        continue;
      }
      await this.spendWake(agent.id, window, now);
      await this.wake(agent.id, entries, session).catch(() => {
        // Surfaced as the agent's error status.
      });
    }
  }

  // --- queue -----------------------------------------------------------------

  private async enqueue(
    agentId: string,
    entries: readonly WakeEntry[],
    now: number
  ): Promise<void> {
    const queue = (await this.read<QueuedWake[]>(QUEUE_KEY)) ?? [];
    const channelId = entries.at(-1)?.channelId ?? "";
    queue.push({ agentId, channelId, enqueuedAt: now, entries: [...entries] });
    await this.write(QUEUE_KEY, queue);
    await this.setStatus(agentId, "queued", channelId, null);
  }

  private async drainQueue(): Promise<void> {
    const queue = (await this.read<QueuedWake[]>(QUEUE_KEY)) ?? [];
    if (queue.length === 0) {
      return;
    }

    const now = Date.now();
    const remaining: QueuedWake[] = [];
    let slots = freeSlots(await this.countActiveSessions());

    for (const item of queue) {
      // FIFO, and each start takes one of the slots the next entry is checking.
      // biome-ignore lint/performance/noAwaitInLoops: the queue drains in order, one slot at a time
      const session = await this.liveSession(item.agentId, now);
      if (!(session || slots > 0)) {
        remaining.push(item);
        continue;
      }
      if (!session) {
        slots -= 1;
      }
      await this.wake(item.agentId, item.entries, session).catch(() => {
        // Dropping a failed wake beats a hot retry loop; status shows the error.
      });
    }

    await this.write(QUEUE_KEY, remaining);
  }

  // --- event pump ------------------------------------------------------------

  private async pumpSessions(): Promise<void> {
    const gateway = this.gateway();
    if (!gateway) {
      return;
    }

    const sessions = await this.ctx.storage.list<StoredSession>({
      prefix: SESSION_KEY_PREFIX,
    });
    const now = Date.now();

    for (const [key, session] of sessions) {
      const agentId = key.slice(SESSION_KEY_PREFIX.length);

      if (now - session.lastActivityAt > SESSION_IDLE_TTL_MS) {
        // At most five sessions exist, and polling them in turn keeps the
        // status writes in a predictable order.
        // biome-ignore lint/performance/noAwaitInLoops: at most five sessions, polled in turn
        await this.ctx.storage.delete(key);
        await this.setStatus(agentId, "idle", session.channelId, null);
        continue;
      }

      if (session.status === "idle") {
        // An idle session emits nothing until we send into it, and both send
        // paths mark it running again - polling it would just burn requests.
        continue;
      }

      await this.pumpOne(gateway, key, agentId, session, now);
    }
  }

  private async pumpOne(
    gateway: AnthropicGateway,
    key: string,
    agentId: string,
    session: StoredSession,
    now: number
  ): Promise<void> {
    let status: SessionStatus;
    let errors: string[];

    try {
      const page = await gateway.pollEvents(
        session.sessionId,
        session.cursorId
          ? { lastEventId: session.cursorId, lastProcessedAt: session.cursorAt }
          : undefined
      );
      ({ errors, status } = reduceEvents(page.events, session.status));
      const { cursor } = page;
      await this.write(key, {
        ...session,
        cursorAt: cursor ? cursor.lastProcessedAt : session.cursorAt,
        cursorId: cursor ? cursor.lastEventId : session.cursorId,
        lastActivityAt: page.events.length > 0 ? now : session.lastActivityAt,
        status,
      } satisfies StoredSession);
    } catch {
      // Poll failures are transient far more often than not: the next tick
      // retries, and the idle TTL is the backstop.
      return;
    }

    if (errors.length > 0) {
      // A session error that names one of the agent's connectors and blames
      // its credentials is the connector's problem, not the session's: it
      // flips that connector to `auth_error` so the UI can offer a re-auth.
      await recordConnectorAuthFailure(this.db, agentId, errors).catch(() => {
        // Health reporting must never cost us the status write below.
      });
      await this.setStatus(
        agentId,
        "error",
        session.channelId,
        session.sessionId
      );
      return;
    }
    if (status === "running") {
      await this.setStatus(
        agentId,
        "working",
        session.channelId,
        session.sessionId
      );
      return;
    }
    if (!isSessionReusable(status)) {
      await this.ctx.storage.delete(key);
      await this.setStatus(agentId, "idle", session.channelId, null);
      return;
    }
    // Idle: kept for reuse until the TTL, but the agent is no longer busy.
    await this.setStatus(agentId, "idle", session.channelId, session.sessionId);
  }

  // --- helpers ---------------------------------------------------------------

  private async countActiveSessions(): Promise<number> {
    const sessions = await this.ctx.storage.list<StoredSession>({
      prefix: SESSION_KEY_PREFIX,
    });
    let active = 0;
    for (const [, session] of sessions) {
      if (session.status === "running") {
        active += 1;
      }
    }
    return active;
  }

  /** The agent's session, if it is still worth sending into. */
  private async liveSession(
    agentId: string,
    now: number
  ): Promise<StoredSession | null> {
    const session = await this.read<StoredSession>(SESSION_KEY(agentId));
    if (!session) {
      return null;
    }
    if (
      !isSessionReusable(session.status) ||
      now - session.lastActivityAt > SESSION_IDLE_TTL_MS
    ) {
      await this.ctx.storage.delete(SESSION_KEY(agentId));
      return null;
    }
    return session;
  }

  private async spendWake(
    agentId: string,
    window: readonly number[],
    now: number
  ): Promise<void> {
    await this.write(RATE_KEY(agentId), checkWakeRate(window, now).timestamps);
  }

  private async setStatus(
    agentId: string,
    status: AgentStatus,
    channelId: string,
    sessionId: string | null
  ): Promise<void> {
    await setAgentRuntimeStatus(this.db, agentId, status, sessionId);
    const agent = await getAgentById(this.db, agentId);

    if (agent && sessionId === null && agent.connectorResyncPendingAt) {
      // The gate just opened: no session means the MCP token can be rotated
      // without cutting one off, which is what a connector resync needs.
      await this.settleConnectors(agent);
    }

    if (!(agent && channelId)) {
      return;
    }
    await broadcastChannelEvent(this.env, {
      agentId,
      agentName: agent.name,
      channelId,
      status,
      type: "agent.status",
    });
  }

  /** One alarm serves three schedules: the pump, the digest, and the queue. */
  private async scheduleNextAlarm(): Promise<void> {
    const now = Date.now();
    const candidates: number[] = [];

    const sessions = await this.ctx.storage.list<StoredSession>({
      prefix: SESSION_KEY_PREFIX,
    });
    let working = false;
    let earliestExpiry = Number.POSITIVE_INFINITY;
    for (const [, session] of sessions) {
      if (session.status !== "idle") {
        working = true;
      }
      earliestExpiry = Math.min(
        earliestExpiry,
        session.lastActivityAt + SESSION_IDLE_TTL_MS
      );
    }

    const queue = (await this.read<QueuedWake[]>(QUEUE_KEY)) ?? [];
    if (working || queue.length > 0) {
      candidates.push(now + PUMP_INTERVAL_MS);
    } else if (Number.isFinite(earliestExpiry)) {
      // Only kept-for-reuse sessions left: the next thing to do is retire them.
      candidates.push(earliestExpiry);
    }
    const digestAt = await this.read<number>(NEXT_DIGEST_KEY);
    if (digestAt !== undefined) {
      candidates.push(digestAt);
    }
    const pending = (await this.read<PendingNotification[]>(PENDING_KEY)) ?? [];
    if (pending.length > 0) {
      candidates.push(now);
    }

    if (candidates.length === 0) {
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...candidates));
  }
}
