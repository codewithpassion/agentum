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

export const channelsRoutes = new Hono<ApiEnv>();

channelsRoutes.use("*", requireAuth);

const isMemberType = (value: string): value is MemberType =>
  (MEMBER_TYPES as readonly string[]).includes(value);

channelsRoutes.get("/", async (c) => {
  const channels = await listChannels(createDb(c.env.DB));
  return c.json({ channels });
});

channelsRoutes.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const body = await readJsonObject(c.req.raw);
  const kind = optionalString(body, "kind") ?? "channel";

  if (kind === "dm") {
    const agentId = requireString(body, "agentId");
    const agent = await getAgentById(db, agentId);
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
  const channel = await createChannel(db, { name });

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
  const channel = await getChannel(db, channelId);
  if (!channel) {
    throw notFound("Channel not found.");
  }
  return c.json({
    channel,
    members: await listChannelMembers(db, channelId),
  });
});

channelsRoutes.delete("/:id", async (c) => {
  const deleted = await deleteChannel(createDb(c.env.DB), c.req.param("id"));
  if (!deleted) {
    throw notFound("Channel not found.");
  }
  return c.body(null, 204);
});

channelsRoutes.post("/:id/members", async (c) => {
  const db = createDb(c.env.DB);
  const channelId = c.req.param("id");
  if (!(await getChannel(db, channelId))) {
    throw notFound("Channel not found.");
  }

  const body = await readJsonObject(c.req.raw);
  const memberType = requireEnum(body, "memberType", MEMBER_TYPES);
  const memberId = requireString(body, "memberId");

  if (memberType === "agent" && !(await getAgentById(db, memberId))) {
    throw notFound("Agent not found.");
  }

  await addChannelMember(db, channelId, { memberType, memberId });
  return c.json({ members: await listChannelMembers(db, channelId) }, 201);
});

channelsRoutes.delete("/:id/members/:memberType/:memberId", async (c) => {
  const db = createDb(c.env.DB);
  const channelId = c.req.param("id");
  if (!(await getChannel(db, channelId))) {
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
  const channelId = c.req.param("id");
  if (!(await getChannel(db, channelId))) {
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

  return c.json(await listChannelMessages(db, { channelId, limit, cursor }));
});

channelsRoutes.post("/:id/messages", async (c) => {
  const db = createDb(c.env.DB);
  const channelId = c.req.param("id");
  if (!(await getChannel(db, channelId))) {
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
  });

  if (!result.ok) {
    throw badRequest(result.reason);
  }

  return c.json({ message: result.message }, 201);
});

channelsRoutes.get("/:id/ws", async (c) => {
  const channelId = c.req.param("id");
  if (!(await getChannel(createDb(c.env.DB), channelId))) {
    throw notFound("Channel not found.");
  }
  return await connectToChannelRoom(c.env, channelId, c.req.raw);
});
