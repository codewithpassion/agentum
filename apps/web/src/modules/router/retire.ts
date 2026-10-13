/**
 * Asks a workspace's router to drop an agent's session, so the agent's next
 * message starts a new one. Lives apart from `agent-router` so the Anthropic
 * service can call it without importing the Durable Object class.
 */
export const retireAgentSession = (
  env: Env,
  workspaceId: string,
  agentId: string
): Promise<{ retired: boolean }> =>
  env.AGENT_ROUTER.get(env.AGENT_ROUTER.idFromName(workspaceId)).retireSession(
    agentId
  );
