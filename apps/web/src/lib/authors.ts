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

export interface Viewer {
  id: string | null;
  imageUrl: string | null;
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

  const isSelf =
    message.authorType === "user" && message.authorId === viewer.id;
  return {
    agentId: null,
    color: UNKNOWN_COLOR,
    imageUrl: isSelf ? viewer.imageUrl : null,
    isSelf,
    name: isSelf ? viewer.name : message.authorId,
  };
};
