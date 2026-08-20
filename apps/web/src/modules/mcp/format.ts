import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AuthorType, MessageView } from "#/modules/messaging/service";

/**
 * The shapes agents see. They are deliberately narrower than the UI's views:
 * every field costs the agent context, so ids it cannot use (R2 keys, mime
 * types, origins) stay out.
 */

export interface McpAuthor {
  id: string;
  name: string;
  type: AuthorType;
}

export interface McpMessage {
  attachments: { filename: string; id: string }[];
  author: McpAuthor;
  body: string;
  createdAt: string;
  id: string;
  mentions: string[];
  replyCount: number;
  threadParentId: string | null;
}

/** Every tool answers in JSON, or fails with a sentence the agent can act on. */
export const json = (payload: unknown): CallToolResult => ({
  content: [{ text: JSON.stringify(payload), type: "text" }],
});

export const fail = (message: string): CallToolResult => ({
  content: [{ text: message, type: "text" }],
  isError: true,
});

const DELETED_AGENT_NAME = "Deleted agent";
/** A bridged surface - a Slack user, say - has no membership to resolve. */
const EXTERNAL_NAME = "Someone outside the workspace";
/**
 * Only for a human view built without an author. `hydrateMessages` resolves
 * every `authorType: "user"` row through `workspace_members` and that lookup
 * answers for every id - "Former member" when the membership is gone - so this
 * is the branch for a view assembled some other way.
 */
const UNKNOWN_HUMAN_NAME = "A former member";

/**
 * Agents get the names their teammates actually go by: an agent's from the
 * roster map, a person's from the workspace membership the view already
 * resolved. No email - a name is what an agent needs to address someone in a
 * channel, and an address is not.
 */
export const authorNameOf = (
  message: Pick<MessageView, "author" | "authorId" | "authorType">,
  agentNamesById: ReadonlyMap<string, string>
): string => {
  if (message.authorType === "agent") {
    return agentNamesById.get(message.authorId) ?? DELETED_AGENT_NAME;
  }
  if (message.authorType === "external") {
    return EXTERNAL_NAME;
  }
  const { author } = message;
  return author ? author.name : UNKNOWN_HUMAN_NAME;
};

export const toMcpMessage = (
  message: MessageView,
  agentNamesById: ReadonlyMap<string, string>
): McpMessage => ({
  attachments: message.attachments.map((attachment) => ({
    filename: attachment.filename,
    id: attachment.id,
  })),
  author: {
    id: message.authorId,
    name: authorNameOf(message, agentNamesById),
    type: message.authorType,
  },
  body: message.body,
  createdAt: new Date(message.createdAt).toISOString(),
  id: message.id,
  mentions: message.mentions.map((mention) => mention.name),
  replyCount: message.replyCount,
  threadParentId: message.threadParentId,
});

/** Keeps a runaway `limit` from pulling a whole channel into the context. */
export const clampLimit = (
  limit: number | undefined,
  { fallback, max }: { fallback: number; max: number }
): number => {
  if (limit === undefined || !Number.isFinite(limit) || limit < 1) {
    return fallback;
  }
  return Math.min(Math.floor(limit), max);
};
