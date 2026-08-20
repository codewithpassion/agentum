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
import { createDb } from "#/db/client";
import { getAgentById } from "#/modules/agents/service";
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
    members: await listChannelMembers(db, channelId),
  });
});

channelsRoutes.delete("/:id", async (c) => {
  const deleted = await deleteChannel(
    createDb(c.env.DB),
    c.get("workspace").id,
    c.req.param("id")
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

  await addChannelMember(db, channelId, { memberType, memberId });
  return c.json({ members: await listChannelMembers(db, channelId) }, 201);
});

channelsRoutes.delete("/:id/members/:memberType/:memberId", async (c) => {
  const db = createDb(c.env.DB);
  const channelId = c.req.param("id");
  if (!(await getChannel(db, c.get("workspace").id, channelId))) {
    throw notFound("Channel not found.");
  }

  const memberType = c.req.param("memberType");
  if (!isMemberType(memberType)) {
    throw badRequest(
      `"memberType" must be one of: ${MEMBER_TYPES.join(", ")}.`
    );
  }

  const removed = await removeChannelMember(db, channelId, {
    memberId: c.req.param("memberId"),
    memberType,
  });
  if (!removed) {
    throw notFound("Member not found.");
  }

  return c.json({ members: await listChannelMembers(db, channelId) });
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
