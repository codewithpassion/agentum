import { asc, eq, inArray } from "drizzle-orm";
import type { Db } from "#/db/client";
import { type Agent, agents } from "./schema";

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

export const createAgent = async (
  db: Db,
  input: CreateAgentInput
): Promise<Agent> => {
  const [agent] = await db
    .insert(agents)
    .values({
      avatar: input.avatar ?? avatarForName(input.name),
      id: crypto.randomUUID(),
      instructions: input.instructions,
      name: input.name,
      soul: input.soul,
    })
    .returning();
  if (!agent) {
    throw new Error("Failed to create the agent.");
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

export const deleteAgent = async (db: Db, id: string): Promise<boolean> => {
  const deleted = await db.delete(agents).where(eq(agents.id, id)).returning({
    id: agents.id,
  });
  return deleted.length > 0;
};
