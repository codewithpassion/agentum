import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "#/db/client";
import {
  getAgentsByIds,
  listAgentMentionCandidates,
} from "#/modules/agents/service";
import { parseMentions } from "./mentions";
import {
  type AUTHOR_TYPES,
  attachments,
  type CHANNEL_KINDS,
  type Channel,
  channelMembers,
  channels,
  type MEMBER_TYPES,
  messageMentions,
  messages,
} from "./schema";

export type AuthorType = (typeof AUTHOR_TYPES)[number];
export type MemberType = (typeof MEMBER_TYPES)[number];
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

export interface AttachmentView {
  filename: string;
  id: string;
  mime: string;
  size: number;
  url: string;
}

export interface MentionView {
  agentId: string;
  name: string;
}

export interface MessageView {
  attachments: AttachmentView[];
  authorId: string;
  authorType: AuthorType;
  body: string;
  channelId: string;
  createdAt: number;
  id: string;
  mentions: MentionView[];
  origin: string;
  replyCount: number;
  threadParentId: string | null;
}

export interface ChannelMemberView {
  avatar: string | null;
  memberId: string;
  memberType: MemberType;
  /** Present for agent members; null for the user. */
  name: string | null;
}

export const attachmentUrl = (id: string): string => `/api/attachments/${id}`;

// --- channels ---------------------------------------------------------------

export const listChannels = (db: Db): Promise<Channel[]> =>
  db.select().from(channels).orderBy(asc(channels.name));

export const getChannel = async (
  db: Db,
  id: string
): Promise<Channel | undefined> => {
  const [channel] = await db.select().from(channels).where(eq(channels.id, id));
  return channel;
};

export const createChannel = async (
  db: Db,
  input: { name: string; kind?: ChannelKind; origin?: string }
): Promise<Channel> => {
  const [channel] = await db
    .insert(channels)
    .values({
      id: crypto.randomUUID(),
      kind: input.kind ?? "channel",
      name: input.name,
      origin: input.origin ?? "native",
    })
    .returning();
  if (!channel) {
    throw new Error("Failed to create the channel.");
  }
  return channel;
};

export const deleteChannel = async (db: Db, id: string): Promise<boolean> => {
  const deleted = await db
    .delete(channels)
    .where(eq(channels.id, id))
    .returning({ id: channels.id });
  return deleted.length > 0;
};

export interface ChannelMemberInput {
  memberId: string;
  memberType: MemberType;
}

export const addChannelMembers = async (
  db: Db,
  channelId: string,
  members: readonly ChannelMemberInput[]
): Promise<void> => {
  if (members.length === 0) {
    return;
  }
  await db
    .insert(channelMembers)
    .values(members.map((member) => ({ channelId, ...member })))
    .onConflictDoNothing();
};

export const addChannelMember = (
  db: Db,
  channelId: string,
  member: ChannelMemberInput
): Promise<void> => addChannelMembers(db, channelId, [member]);

/** The channels a member can see - an agent's whole world, for the MCP tools. */
export const listChannelsForMember = (
  db: Db,
  member: ChannelMemberInput
): Promise<Channel[]> =>
  db
    .select({ channel: channels })
    .from(channels)
    .innerJoin(channelMembers, eq(channelMembers.channelId, channels.id))
    .where(
      and(
        eq(channelMembers.memberType, member.memberType),
        eq(channelMembers.memberId, member.memberId)
      )
    )
    .orderBy(asc(channels.name))
    .then((rows) => rows.map((row) => row.channel));

export const isChannelMember = async (
  db: Db,
  channelId: string,
  member: ChannelMemberInput
): Promise<boolean> => {
  const [row] = await db
    .select({ memberId: channelMembers.memberId })
    .from(channelMembers)
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.memberType, member.memberType),
        eq(channelMembers.memberId, member.memberId)
      )
    );
  return row !== undefined;
};

export const listChannelMembers = async (
  db: Db,
  channelId: string
): Promise<ChannelMemberView[]> => {
  const rows = await db
    .select()
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channelId))
    .orderBy(asc(channelMembers.memberType), asc(channelMembers.createdAt));

  const agentIds = rows
    .filter((row) => row.memberType === "agent")
    .map((row) => row.memberId);
  const agents = await getAgentsByIds(db, agentIds);
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  return rows.map((row) => {
    const agent = agentsById.get(row.memberId);
    return {
      avatar: row.memberType === "agent" ? (agent?.avatar ?? null) : null,
      memberId: row.memberId,
      memberType: row.memberType,
      name: row.memberType === "agent" ? (agent?.name ?? null) : null,
    };
  });
};

/**
 * DMs are one-per-agent: the same channel is reused so a user always lands in
 * the same conversation.
 */
export const getOrCreateAgentDm = async (
  db: Db,
  agent: { id: string; name: string },
  userId: string
): Promise<Channel> => {
  const [existing] = await db
    .select({ channel: channels })
    .from(channels)
    .innerJoin(channelMembers, eq(channelMembers.channelId, channels.id))
    .where(
      and(
        eq(channels.kind, "dm"),
        eq(channelMembers.memberType, "agent"),
        eq(channelMembers.memberId, agent.id)
      )
    );
  if (existing) {
    await addChannelMember(db, existing.channel.id, {
      memberId: userId,
      memberType: "user",
    });
    return existing.channel;
  }

  const channel = await createChannel(db, { kind: "dm", name: agent.name });
  await addChannelMembers(db, channel.id, [
    { memberId: userId, memberType: "user" },
    { memberId: agent.id, memberType: "agent" },
  ]);
  return channel;
};

// --- messages ---------------------------------------------------------------

export interface MessageCursor {
  createdAt: number;
  id: string;
}

const CURSOR_SEPARATOR = ":";

export const encodeCursor = (message: {
  createdAt: Date;
  id: string;
}): string => `${message.createdAt.getTime()}${CURSOR_SEPARATOR}${message.id}`;

export const decodeCursor = (raw: string): MessageCursor | undefined => {
  const separatorIndex = raw.indexOf(CURSOR_SEPARATOR);
  if (separatorIndex <= 0) {
    return;
  }
  const createdAt = Number.parseInt(raw.slice(0, separatorIndex), 10);
  const id = raw.slice(separatorIndex + 1);
  if (!(Number.isFinite(createdAt) && id)) {
    return;
  }
  return { createdAt, id };
};

type MessageRow = typeof messages.$inferSelect;

const hydrateMessages = async (
  db: Db,
  rows: MessageRow[]
): Promise<MessageView[]> => {
  if (rows.length === 0) {
    return [];
  }
  const ids = rows.map((row) => row.id);

  const [attachmentRows, mentionRows, replyCountRows] = await Promise.all([
    db.select().from(attachments).where(inArray(attachments.messageId, ids)),
    db
      .select()
      .from(messageMentions)
      .where(inArray(messageMentions.messageId, ids)),
    db
      .select({
        replyCount: sql<number>`count(*)`,
        threadParentId: messages.threadParentId,
      })
      .from(messages)
      .where(inArray(messages.threadParentId, ids))
      .groupBy(messages.threadParentId),
  ]);

  const mentionedAgents = await getAgentsByIds(
    db,
    mentionRows.map((row) => row.agentId)
  );
  const agentNamesById = new Map(
    mentionedAgents.map((agent) => [agent.id, agent.name])
  );

  const attachmentsByMessage = new Map<string, AttachmentView[]>();
  for (const row of attachmentRows) {
    if (!row.messageId) {
      continue;
    }
    const list = attachmentsByMessage.get(row.messageId) ?? [];
    list.push({
      filename: row.filename,
      id: row.id,
      mime: row.mime,
      size: row.size,
      url: attachmentUrl(row.id),
    });
    attachmentsByMessage.set(row.messageId, list);
  }

  const mentionsByMessage = new Map<string, MentionView[]>();
  for (const row of mentionRows) {
    const name = agentNamesById.get(row.agentId);
    if (!name) {
      // The agent was deleted after being mentioned.
      continue;
    }
    const list = mentionsByMessage.get(row.messageId) ?? [];
    list.push({ agentId: row.agentId, name });
    mentionsByMessage.set(row.messageId, list);
  }

  const replyCounts = new Map(
    replyCountRows.flatMap((row) =>
      row.threadParentId ? [[row.threadParentId, row.replyCount] as const] : []
    )
  );

  return rows.map((row) => ({
    attachments: attachmentsByMessage.get(row.id) ?? [],
    authorId: row.authorId,
    authorType: row.authorType,
    body: row.body,
    channelId: row.channelId,
    createdAt: row.createdAt.getTime(),
    id: row.id,
    mentions: mentionsByMessage.get(row.id) ?? [],
    origin: row.origin,
    replyCount: replyCounts.get(row.id) ?? 0,
    threadParentId: row.threadParentId,
  }));
};

/** Newest-first page of top-level messages; thread replies are excluded. */
export const listChannelMessages = async (
  db: Db,
  options: { channelId: string; limit: number; cursor?: MessageCursor }
): Promise<{ messages: MessageView[]; nextCursor: string | null }> => {
  const { channelId, limit, cursor } = options;
  const cursorCondition = cursor
    ? or(
        lt(messages.createdAt, new Date(cursor.createdAt)),
        and(
          eq(messages.createdAt, new Date(cursor.createdAt)),
          lt(messages.id, cursor.id)
        )
      )
    : undefined;

  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.channelId, channelId),
        isNull(messages.threadParentId),
        cursorCondition
      )
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    messages: await hydrateMessages(db, page),
    nextCursor: rows.length > limit && last ? encodeCursor(last) : null,
  };
};

export const getMessage = async (
  db: Db,
  id: string
): Promise<MessageRow | undefined> => {
  const [message] = await db.select().from(messages).where(eq(messages.id, id));
  return message;
};

export const getThread = async (
  db: Db,
  parentId: string
): Promise<{ parent: MessageView; replies: MessageView[] } | undefined> => {
  const parentRow = await getMessage(db, parentId);
  if (!parentRow) {
    return;
  }
  const replyRows = await db
    .select()
    .from(messages)
    .where(eq(messages.threadParentId, parentId))
    .orderBy(asc(messages.createdAt), asc(messages.id));

  const [parent] = await hydrateMessages(db, [parentRow]);
  if (!parent) {
    return;
  }
  return { parent, replies: await hydrateMessages(db, replyRows) };
};

export interface CreateMessageInput {
  attachmentIds?: string[];
  authorId: string;
  authorType: AuthorType;
  body: string;
  channelId: string;
  origin?: string;
  threadParentId?: string;
}

export type CreateMessageResult =
  | { ok: true; message: MessageView }
  | { ok: false; reason: string };

export const createMessage = async (
  db: Db,
  input: CreateMessageInput
): Promise<CreateMessageResult> => {
  if (input.threadParentId) {
    const parent = await getMessage(db, input.threadParentId);
    if (!parent || parent.channelId !== input.channelId) {
      return { ok: false, reason: "The thread parent is not in this channel." };
    }
    if (parent.threadParentId) {
      return { ok: false, reason: "Threads are only one level deep." };
    }
  }

  const attachmentIds = input.attachmentIds ?? [];
  if (attachmentIds.length > 0) {
    const claimable = await db
      .select({ id: attachments.id })
      .from(attachments)
      .where(
        and(
          inArray(attachments.id, attachmentIds),
          isNull(attachments.messageId)
        )
      );
    if (claimable.length !== attachmentIds.length) {
      return {
        ok: false,
        reason: "One or more attachments are unknown or already in use.",
      };
    }
  }

  const candidates = await listAgentMentionCandidates(db);
  const mentions = parseMentions(input.body, candidates);

  const id = crypto.randomUUID();
  const insertMessage = db.insert(messages).values({
    authorId: input.authorId,
    authorType: input.authorType,
    body: input.body,
    channelId: input.channelId,
    id,
    origin: input.origin ?? "native",
    threadParentId: input.threadParentId ?? null,
  });

  const followUps = [
    ...(attachmentIds.length > 0
      ? [
          db
            .update(attachments)
            .set({ messageId: id })
            .where(inArray(attachments.id, attachmentIds)),
        ]
      : []),
    ...(mentions.length > 0
      ? [
          db.insert(messageMentions).values(
            mentions.map((mention) => ({
              agentId: mention.id,
              messageId: id,
            }))
          ),
        ]
      : []),
  ];

  await db.batch([insertMessage, ...followUps]);

  const row = await getMessage(db, id);
  if (!row) {
    throw new Error("Failed to create the message.");
  }
  const [message] = await hydrateMessages(db, [row]);
  if (!message) {
    throw new Error("Failed to load the created message.");
  }
  return { message, ok: true };
};
