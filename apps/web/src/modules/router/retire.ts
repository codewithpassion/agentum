import type { SessionEndReason } from "#/modules/agents/schema";
import type { SessionStatus } from "#/modules/anthropic/events";

/**
 * Asks a workspace's router to drop an agent's session, so the agent's next
 * message starts a new one. Lives apart from `agent-router` so the Anthropic
 * service can call it without importing the Durable Object class.
 */
export const retireAgentSession = (
  env: Env,
  workspaceId: string,
  agentId: string,
  reason: SessionEndReason = "reset"
): Promise<{ retired: boolean }> =>
  env.AGENT_ROUTER.get(env.AGENT_ROUTER.idFromName(workspaceId)).retireSession(
    agentId,
    reason
  );

/** Makes an earlier session the agent's current one; see `switchSession`. */
export const switchAgentSession = (
  env: Env,
  workspaceId: string,
  agentId: string,
  target: { model: string | null; sessionId: string; status: SessionStatus }
): Promise<void> =>
  env.AGENT_ROUTER.get(env.AGENT_ROUTER.idFromName(workspaceId)).switchSession(
    agentId,
    target
  );
