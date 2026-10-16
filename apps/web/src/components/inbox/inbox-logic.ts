import type { InboxPost } from "#/integrations/trpc/types";

export interface AgentName {
  id: string;
  name: string;
}

export const agentNameMap = (
  agents: readonly AgentName[]
): Map<string, string> =>
  new Map(agents.map((agent) => [agent.id, agent.name]));

/** "You" for the signed-in user, "Teammate" for other users, the agent's name or "Agent". */
export const authorLabel = (
  post: Pick<InboxPost, "authorId" | "authorKind">,
  userId: string,
  agentNames: ReadonlyMap<string, string>
): string => {
  if (post.authorKind === "agent") {
    return agentNames.get(post.authorId) ?? "Agent";
  }
  return post.authorId === userId ? "You" : "Teammate";
};

export const canSend = (text: string, sending: boolean): boolean =>
  !sending && text.trim().length > 0;
