import { and, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { type ChannelBridge, channelBridges } from "./schema";

/** CRUD for `channel_bridges` - the only thing that makes a channel bridged. */

export interface CreateBridgeInput {
  agentId: string | null;
  channelId: string;
  connector: string;
  externalChannelId: string;
}

export const getBridge = async (
  db: Db,
  channelId: string,
  connector: string
): Promise<ChannelBridge | undefined> => {
  const [bridge] = await db
    .select()
    .from(channelBridges)
    .where(
      and(
        eq(channelBridges.channelId, channelId),
        eq(channelBridges.connector, connector)
      )
    );
  return bridge;
};

export const findBridgeByExternalChannel = async (
  db: Db,
  connector: string,
  externalChannelId: string
): Promise<ChannelBridge | undefined> => {
  const [bridge] = await db
    .select()
    .from(channelBridges)
    .where(
      and(
        eq(channelBridges.connector, connector),
        eq(channelBridges.externalChannelId, externalChannelId)
      )
    );
  return bridge;
};

/** Every bridge for a channel - what the outbound mirror iterates. */
export const listBridgesForChannel = (
  db: Db,
  channelId: string
): Promise<ChannelBridge[]> =>
  db
    .select()
    .from(channelBridges)
    .where(eq(channelBridges.channelId, channelId));

/** Which external surfaces can reach this agent - the agent rail's card. */
export const listBridgesForAgent = (
  db: Db,
  agentId: string
): Promise<ChannelBridge[]> =>
  db.select().from(channelBridges).where(eq(channelBridges.agentId, agentId));

/** Re-bridging a channel replaces the previous mapping rather than failing. */
export const upsertBridge = async (
  db: Db,
  input: CreateBridgeInput
): Promise<ChannelBridge> => {
  await db
    .delete(channelBridges)
    .where(
      and(
        eq(channelBridges.connector, input.connector),
        eq(channelBridges.externalChannelId, input.externalChannelId)
      )
    );

  const [bridge] = await db
    .insert(channelBridges)
    .values({
      agentId: input.agentId,
      channelId: input.channelId,
      connector: input.connector,
      externalChannelId: input.externalChannelId,
      id: crypto.randomUUID(),
      status: "active",
    })
    .onConflictDoUpdate({
      set: {
        agentId: input.agentId,
        externalChannelId: input.externalChannelId,
        status: "active",
      },
      target: [channelBridges.channelId, channelBridges.connector],
    })
    .returning();

  if (!bridge) {
    throw new Error("Failed to save the bridge.");
  }
  return bridge;
};

export const deleteBridge = async (
  db: Db,
  channelId: string,
  connector: string
): Promise<boolean> => {
  const deleted = await db
    .delete(channelBridges)
    .where(
      and(
        eq(channelBridges.channelId, channelId),
        eq(channelBridges.connector, connector)
      )
    )
    .returning({ id: channelBridges.id });
  return deleted.length > 0;
};
