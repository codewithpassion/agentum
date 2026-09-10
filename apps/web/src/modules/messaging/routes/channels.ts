import { Hono } from "hono";
import { requireAuth } from "#/api/require-auth";
import type { ApiEnv } from "#/api/types";
import {
  badRequest,
  notFound,
  optionalString,
  optionalStringArray,
  parsePositiveInt,
  readJsonObject,
  requireEnum,
  requireString,
} from "#/api/validation";
import { createDb, type Db } from "#/db/client";
import { deleteOverridesForChannel } from "#/modules/agents/model-overrides";
import { getAgentById } from "#/modules/agents/service";
import { deleteBridgesForChannel } from "#/modules/bridges/bridges";
import { deleteExternalRefsForMessages } from "#/modules/bridges/refs";
import { deleteQuestionsForChannel } from "#/modules/questions/service";
import { requireOwner } from "#/modules/workspaces/require-workspace";
import { getMemberById } from "#/modules/workspaces/service";
import { publishMessage } from "../publish";
import { connectToChannelRoom } from "../realtime";
import { MEMBER_TYPES } from "../schema";
import {
  addChannelMember,
  addChannelMembers,
  createChannel,
  decodeCursor,
  deleteChannel,
  getChannel,
  getOrCreateAgentDm,
  listChannelMembers,
  listChannelMessages,
  listChannels,
  listMessageIdsForChannel,
  type MemberType,
  removeChannelMember,
} from "../service";

const CHANNEL_NAME_MAX_LENGTH = 80;
const MESSAGE_BODY_MAX_LENGTH = 50_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Mounted under `/api/w/:slug`. `channels` is the only table here that carries
 * a workspace of its own: members, messages, attachments and mentions inherit
 * it, so every route below resolves the channel *within the workspace* first
 * and works underneath it from there.
 */
export const channelsRoutes = new Hono<ApiEnv>();

channelsRoutes.use("*", requireAuth);

const isMemberType = (value: string): value is MemberType =>
  (MEMBER_TYPES as readonly string[]).includes(value);

/**
 * A user member is addressed from outside by their *workspace member* id - the
 * only identity for a person that ever leaves the server - and stored by the
 * Clerk id behind it, which is what survives a member being removed and added
 * back. This is where the two meet, in both directions of a member write.
 */
const clerkIdOfMember = async (
  db: Db,
  workspaceId: string,
  memberId: string
): Promise<string> => {
  const member = await getMemberById(db, workspaceId, memberId);
  if (!member) {
    throw notFound("Member not found.");
  }
  return member.clerkUserId;
};

channelsRoutes.get("/", async (c) => {
  const channels = await listChannels(
    createDb(c.env.DB),
    c.get("workspace").id
  );
  return c.json({ channels });
});

channelsRoutes.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");
  const body = await readJsonObject(c.req.raw);
  const kind = optionalString(body, "kind") ?? "channel";

  if (kind === "dm") {
    const agentId = requireString(body, "agentId");
    const agent = await getAgentById(db, workspace.id, agentId);
    if (!agent) {
      throw notFound("Agent not found.");
    }
    const channel = await getOrCreateAgentDm(db, agent, c.get("userId"));
    return c.json({ channel }, 201);
  }

  if (kind !== "channel") {
    throw badRequest('"kind" must be one of: channel, dm.');
  }

  const name = requireString(body, "name", {
    maxLength: CHANNEL_NAME_MAX_LENGTH,
  });
  const agentIds = optionalStringArray(body, "agentIds") ?? [];
  // Agents named at creation have to be this workspace's, or the channel would
  // be seeded with a member nobody in it can see.
  for (const agentId of agentIds) {
    // biome-ignore lint/performance/noAwaitInLoops: a handful of ids, and each is a point lookup
    if (!(await getAgentById(db, workspace.id, agentId))) {
      throw notFound("Agent not found.");
    }
  }

  const channel = await createChannel(db, workspace.id, { name });

  await addChannelMembers(db, channel.id, [
    { memberType: "user", memberId: c.get("userId") },
    ...agentIds.map((agentId) => ({
      memberType: "agent" as const,
      memberId: agentId,
    })),
  ]);

  return c.json({ channel }, 201);
});

channelsRoutes.get("/:id", async (c) => {
  const db = createDb(c.env.DB);
  const channelId = c.req.param("id");
  const channel = await getChannel(db, c.get("workspace").id, channelId);
  if (!channel) {
    throw notFound("Channel not found.");
  }
  return c.json({
    channel,
    members: await listChannelMembers(db, c.get("workspace").id, channelId),
  });
});

/**
 * Deleting a channel takes its whole history with it - every message, thread,
 * attachment and the objects behind them - so it is owner-gated, unlike
 * creating one: adding a room costs nothing to undo, and this cannot be undone
 * at all.
 *
 * The channel is resolved against the workspace *before* anything is deleted.
 * Every cleanup below keys off a bare channel id, and the modules holding those
 * rows have no workspace of their own to check against, so skipping this would
 * let one workspace's id drop another's bridges and questions.
 *
 * Routines pointing at the channel are deliberately left: a routine whose room
 * is gone fails its next run with "the room is gone", which is a visible error
 * its owner can act on, where a silently vanished routine is not.
 */
channelsRoutes.delete("/:id", requireOwner, async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const channelId = c.req.param("id");
  if (!(await getChannel(db, workspaceId, channelId))) {
    throw notFound("Channel not found.");
  }

  // The refs name messages, so they are read before the channel takes those
  // messages with it.
  await deleteExternalRefsForMessages(
    db,
    await listMessageIdsForChannel(db, channelId)
  );
  await deleteBridgesForChannel(db, workspaceId, channelId);
  await deleteQuestionsForChannel(db, workspaceId, channelId);
  await deleteOverridesForChannel(db, workspaceId, channelId);

  const deleted = await deleteChannel(
    db,
    c.env.ATTACHMENTS,
    workspaceId,
    channelId
  );
  if (!deleted) {
    throw notFound("Channel not found.");
  }
  return c.body(null, 204);
});

channelsRoutes.post("/:id/members", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const channelId = c.req.param("id");
  if (!(await getChannel(db, workspaceId, channelId))) {
    throw notFound("Channel not found.");
  }

  const body = await readJsonObject(c.req.raw);
  const memberType = requireEnum(body, "memberType", MEMBER_TYPES);
  const memberId = requireString(body, "memberId");

  if (
    memberType === "agent" &&
    !(await getAgentById(db, workspaceId, memberId))
  ) {
    throw notFound("Agent not found.");
  }

  await addChannelMember(db, channelId, {
    memberId:
      memberType === "user"
        ? await clerkIdOfMember(db, workspaceId, memberId)
        : memberId,
    memberType,
  });
  return c.json(
    { members: await listChannelMembers(db, workspaceId, channelId) },
    201
  );
});

channelsRoutes.delete("/:id/members/:memberType/:memberId", async (c) => {
  const db = createDb(c.env.DB);
  const workspaceId = c.get("workspace").id;
  const channelId = c.req.param("id");
  if (!(await getChannel(db, workspaceId, channelId))) {
    throw notFound("Channel not found.");
  }

  const memberType = c.req.param("memberType");
  if (!isMemberType(memberType)) {
    throw badRequest(
      `"memberType" must be one of: ${MEMBER_TYPES.join(", ")}.`
    );
  }

  const memberId = c.req.param("memberId");
  const removed = await removeChannelMember(db, channelId, {
    memberId:
      memberType === "user"
        ? await clerkIdOfMember(db, workspaceId, memberId)
        : memberId,
    memberType,
  });
  if (!removed) {
    throw notFound("Member not found.");
  }

  return c.json({
    members: await listChannelMembers(db, workspaceId, channelId),
  });
});

channelsRoutes.get("/:id/messages", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");
  const channelId = c.req.param("id");
  if (!(await getChannel(db, workspace.id, channelId))) {
    throw notFound("Channel not found.");
  }

  const limit = parsePositiveInt(c.req.query("limit"), {
    fallback: DEFAULT_PAGE_SIZE,
    max: MAX_PAGE_SIZE,
  });
  const rawCursor = c.req.query("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : undefined;
  if (rawCursor && !cursor) {
    throw badRequest('"cursor" is malformed.');
  }

  return c.json(
    await listChannelMessages(db, workspace, { channelId, limit, cursor })
  );
});

channelsRoutes.post("/:id/messages", async (c) => {
  const db = createDb(c.env.DB);
  const workspace = c.get("workspace");
  const channelId = c.req.param("id");
  if (!(await getChannel(db, workspace.id, channelId))) {
    throw notFound("Channel not found.");
  }

  const body = await readJsonObject(c.req.raw);
  const result = await publishMessage(db, c.env, {
    channelId,
    authorType: "user",
    authorId: c.get("userId"),
    body: requireString(body, "body", { maxLength: MESSAGE_BODY_MAX_LENGTH }),
    threadParentId: optionalString(body, "threadParentId"),
    attachmentIds: optionalStringArray(body, "attachmentIds"),
    workspace,
  });

  if (!result.ok) {
    throw badRequest(result.reason);
  }

  return c.json({ message: result.message }, 201);
});

/**
 * The socket. `ChannelRoom` is keyed by channel id, which is globally unique,
 * so the room needs no rekeying - but the channel still has to be proved to be
 * this workspace's before a connection to it is handed out.
 */
channelsRoutes.get("/:id/ws", async (c) => {
  const channelId = c.req.param("id");
  if (
    !(await getChannel(createDb(c.env.DB), c.get("workspace").id, channelId))
  ) {
    throw notFound("Channel not found.");
  }
  return await connectToChannelRoom(c.env, channelId, c.req.raw);
});
