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

/**
 * True when the newest post is an agent's and no person has dismissed the
 * thread since. A dismissal at or after that post hides it, as on the server.
 */
export const threadWaits = (
  thread: { attentionClearedAt: string | null },
  posts: readonly Pick<InboxPost, "authorKind" | "createdAt">[]
): boolean => {
  const newest = posts.at(-1);
  if (newest === undefined || newest.authorKind !== "agent") {
    return false;
  }
  return (
    thread.attentionClearedAt === null ||
    thread.attentionClearedAt < newest.createdAt
  );
};
