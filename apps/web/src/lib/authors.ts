import type { Agent, MessageView } from "./api";

export interface AuthorInfo {
  /** Set when the author is an agent, so the UI can open its profile. */
  agentId: string | null;
  color: string;
  imageUrl: string | null;
  isSelf: boolean;
  name: string;
}

const UNKNOWN_COLOR = "#52525b";
const FORMER_MEMBER_NAME = "Former member";

/**
 * The signed-in human, as this client knows itself: `memberId` is the caller's
 * `workspace_members` row (from `GET /api/w/:slug`), which is the only identity
 * a message carries for a person - there is no Clerk id to compare against.
 */
export interface Viewer {
  imageUrl: string | null;
  memberId: string | null;
  name: string;
}

export const authorOf = (
  message: MessageView,
  agentsById: Map<string, Agent>,
  viewer: Viewer
): AuthorInfo => {
  if (message.authorType === "agent") {
    const agent = agentsById.get(message.authorId);
    return {
      agentId: agent?.id ?? null,
      color: agent?.avatar ?? UNKNOWN_COLOR,
      imageUrl: null,
      isSelf: false,
      name: agent?.name ?? "Deleted agent",
    };
  }

  // Somebody on a bridged surface: their handle there is all we have of them.
  if (message.authorType === "external") {
    return {
      agentId: null,
      color: UNKNOWN_COLOR,
      imageUrl: null,
      isSelf: false,
      name: message.authorId,
    };
  }

  const { author } = message;
  if (!author) {
    // A user message with no resolved author is a view that skipped hydration.
    return {
      agentId: null,
      color: UNKNOWN_COLOR,
      imageUrl: null,
      isSelf: false,
      name: FORMER_MEMBER_NAME,
    };
  }

  const isSelf =
    author.memberId !== null && author.memberId === viewer.memberId;
  return {
    agentId: null,
    color: UNKNOWN_COLOR,
    imageUrl: isSelf ? viewer.imageUrl : author.imageUrl,
    isSelf,
    name: isSelf ? viewer.name : author.name,
  };
};
