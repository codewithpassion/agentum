import { and, desc, eq } from "drizzle-orm";
import type { Db } from "#/db/client";
import { broadcastChannelEvent } from "./realtime";
import { channelMembers, channels, messages } from "./schema";
import { createMessage, type MessageView } from "./service";
import {
  SESSION_START_ORIGIN,
  sessionStartAuthorId,
  sessionStartBody,
} from "./session-origin";

/**
 * Posts "New session started for X." into a channel. It goes through
 * `createMessage` and the channel broadcast only, not `publishMessage`: a
 * divider must not wake an agent, count toward the loop guard, or be mirrored
 * to a bridged surface, and `publishMessage` does all three.
 */
export const postSessionDivider = async (
  db: Db,
  env: Env,
  input: {
    agent: { id: string; name: string };
    channelId: string;
    workspaceId: string;
  }
): Promise<MessageView | null> => {
  const result = await createMessage(db, {
    authorId: sessionStartAuthorId(input.agent.id),
    authorType: "external",
    body: sessionStartBody(input.agent.name),
    channelId: input.channelId,
    origin: SESSION_START_ORIGIN,
    // The slug only builds attachment URLs, and a divider has none.
    workspace: { id: input.workspaceId, slug: "" },
  });
  if (!result.ok) {
    return null;
  }
  await broadcastChannelEvent(env, {
    channelId: input.channelId,
    message: result.message,
    type: "message.created",
  });
  return result.message;
};

/** The agent's DM channel in the workspace, if one has been opened. */
export const findAgentDmId = async (
  db: Db,
  workspaceId: string,
  agentId: string
): Promise<string | null> => {
  const [row] = await db
    .select({ id: channels.id })
    .from(channels)
    .innerJoin(channelMembers, eq(channelMembers.channelId, channels.id))
    .where(
      and(
        eq(channels.workspaceId, workspaceId),
        eq(channels.kind, "dm"),
        eq(channelMembers.memberType, "agent"),
        eq(channelMembers.memberId, agentId)
      )
    )
    .limit(1);
  return row?.id ?? null;
};

/** The newest divider an agent has in a channel; where its context begins. */
export const getLatestSessionStart = async (
  db: Db,
  channelId: string,
  agentId: string
): Promise<{ createdAt: number; id: string } | null> => {
  const [row] = await db
    .select({ createdAt: messages.createdAt, id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        eq(messages.origin, SESSION_START_ORIGIN),
        eq(messages.authorId, sessionStartAuthorId(agentId))
      )
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row ? { createdAt: row.createdAt.getTime(), id: row.id } : null;
};

/**
 * Cuts a newest-first page at the divider: keeps everything up to and
 * including it. `reached` says the page ran back to the divider, so older
 * pages are the previous session's.
 */
export const windowSinceDivider = <T extends { id: string }>(
  newestFirst: readonly T[],
  dividerId: string
): { messages: T[]; reached: boolean } => {
  const index = newestFirst.findIndex((message) => message.id === dividerId);
  return index === -1
    ? { messages: [...newestFirst], reached: false }
    : { messages: newestFirst.slice(0, index + 1), reached: true };
};
