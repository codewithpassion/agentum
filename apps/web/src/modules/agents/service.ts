import { asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "#/db/client";
import { generateMcpToken, hashMcpToken, timingSafeEqual } from "./mcp-token";
import {
  type AGENT_STATUSES,
  type AGENT_SYNC_STATUSES,
  type Agent,
  agents,
} from "./schema";

export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type AgentSyncStatus = (typeof AGENT_SYNC_STATUSES)[number];

const AVATAR_COLORS = [
  "#f97316",
  "#ef4444",
  "#ec4899",
  "#a855f7",
  "#6366f1",
  "#0ea5e9",
  "#14b8a6",
  "#22c55e",
  "#eab308",
] as const;

const HASH_PRIME = 31;

/** Deterministic avatar colour so an agent looks the same everywhere. */
export const avatarForName = (name: string): string => {
  let hash = 0;
  for (const character of name) {
    hash =
      (hash * HASH_PRIME + (character.codePointAt(0) ?? 0)) % 2_147_483_647;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
};

export type AgentSummary = Pick<Agent, "id" | "name" | "avatar">;

/**
 * What every transport is allowed to hand out: the token hash never leaves the
 * server, so callers see only whether a token has been issued.
 */
export type AgentView = Omit<Agent, "mcpTokenHash"> & { hasMcpToken: boolean };

export const toAgentView = (agent: Agent): AgentView => {
  const { mcpTokenHash, ...rest } = agent;
  return { ...rest, hasMcpToken: mcpTokenHash !== null };
};

export const listAgents = (db: Db): Promise<Agent[]> =>
  db.select().from(agents).orderBy(asc(agents.name));

export const getAgentById = async (
  db: Db,
  id: string
): Promise<Agent | undefined> => {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  return agent;
};

export const getAgentsByIds = async (
  db: Db,
  ids: readonly string[]
): Promise<Agent[]> => {
  if (ids.length === 0) {
    return [];
  }
  return await db
    .select()
    .from(agents)
    .where(inArray(agents.id, [...ids]));
};

/** Mention candidates for the messaging module - names plus their agent ids. */
export const listAgentMentionCandidates = async (
  db: Db
): Promise<{ id: string; name: string }[]> =>
  await db.select({ id: agents.id, name: agents.name }).from(agents);

export interface CreateAgentInput {
  avatar?: string;
  instructions: string;
  name: string;
  soul: string;
}

/** The plaintext MCP token is only ever available here and on rotation. */
export interface IssuedAgent {
  agent: Agent;
  mcpToken: string;
}

export const createAgent = async (
  db: Db,
  workspaceId: string,
  input: CreateAgentInput
): Promise<IssuedAgent> => {
  const mcpToken = generateMcpToken();
  const [agent] = await db
    .insert(agents)
    .values({
      avatar: input.avatar ?? avatarForName(input.name),
      id: crypto.randomUUID(),
      instructions: input.instructions,
      mcpTokenHash: await hashMcpToken(mcpToken),
      name: input.name,
      soul: input.soul,
      workspaceId,
    })
    .returning();
  if (!agent) {
    throw new Error("Failed to create the agent.");
  }
  return { agent, mcpToken };
};

/** Invalidates the agent's current MCP URL and returns the replacement token. */
export const rotateMcpToken = async (
  db: Db,
  id: string
): Promise<IssuedAgent | undefined> => {
  const mcpToken = generateMcpToken();
  const [agent] = await db
    .update(agents)
    .set({ mcpTokenHash: await hashMcpToken(mcpToken), updatedAt: new Date() })
    .where(eq(agents.id, id))
    .returning();
  return agent ? { agent, mcpToken } : undefined;
};

/** Resolves `/mcp/:agentToken` to its agent; undefined means "not an agent". */
export const findAgentByMcpToken = async (
  db: Db,
  token: string
): Promise<Agent | undefined> => {
  const hash = await hashMcpToken(token);
  const [agent] = await db
    .select()
    .from(agents)
    .where(eq(agents.mcpTokenHash, hash));
  if (!(agent?.mcpTokenHash && timingSafeEqual(agent.mcpTokenHash, hash))) {
    return;
  }
  return agent;
};

export type UpdateAgentInput = Partial<CreateAgentInput>;

export const updateAgent = async (
  db: Db,
  id: string,
  input: UpdateAgentInput
): Promise<Agent | undefined> => {
  const [agent] = await db
    .update(agents)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(agents.id, id))
    .returning();
  return agent;
};

/**
 * Records a successful Anthropic registration. Written by `modules/anthropic`
 * after `agents.create`, which is the only place these two ids come from.
 */
export const setAgentRegistration = async (
  db: Db,
  id: string,
  registration: { anthropicAgentId: string; memoryStoreId: string | null }
): Promise<void> => {
  await db
    .update(agents)
    .set({
      anthropicAgentId: registration.anthropicAgentId,
      memoryStoreId: registration.memoryStoreId,
      syncError: null,
      syncStatus: "synced",
    })
    .where(eq(agents.id, id));
};

/** Registration is best-effort, so its failures are shown, not thrown. */
export const setAgentSyncStatus = async (
  db: Db,
  id: string,
  syncStatus: AgentSyncStatus,
  syncError?: string
): Promise<void> => {
  await db
    .update(agents)
    .set({ syncError: syncError ?? null, syncStatus })
    .where(eq(agents.id, id));
};

/**
 * The router's view of the agent, mirrored into D1 so a page load shows the
 * same thing the live socket would have. `updatedAt` deliberately stays put:
 * this is activity, not an edit.
 */
export const setAgentRuntimeStatus = async (
  db: Db,
  id: string,
  status: AgentStatus,
  sessionId: string | null
): Promise<void> => {
  await db.update(agents).set({ sessionId, status }).where(eq(agents.id, id));
};

/**
 * Records that a connector change left this agent's `mcp_servers` stale. The
 * flag is durable because the resync itself is not: it has to wait for the
 * agent to have no session, and it has to survive a failed attempt.
 */
export const markAgentsForConnectorResync = async (
  db: Db,
  ids: readonly string[]
): Promise<void> => {
  if (ids.length === 0) {
    return;
  }
  // `updatedAt` stays put: this is bookkeeping, not an edit to the agent.
  await db
    .update(agents)
    .set({ connectorResyncPendingAt: new Date() })
    .where(inArray(agents.id, [...ids]));
};

export const clearConnectorResyncPending = async (
  db: Db,
  id: string
): Promise<void> => {
  await db
    .update(agents)
    .set({ connectorResyncPendingAt: null })
    .where(eq(agents.id, id));
};

export const listAgentsPendingConnectorResync = (db: Db): Promise<Agent[]> =>
  db
    .select()
    .from(agents)
    .where(isNotNull(agents.connectorResyncPendingAt))
    .orderBy(asc(agents.name));

export const deleteAgent = async (db: Db, id: string): Promise<boolean> => {
  const deleted = await db.delete(agents).where(eq(agents.id, id)).returning({
    id: agents.id,
  });
  return deleted.length > 0;
};
