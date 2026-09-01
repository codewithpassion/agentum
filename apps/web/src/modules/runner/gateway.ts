import { advanceCursor, type SessionEvent } from "#/modules/anthropic/events";
import type { SessionGateway } from "#/modules/anthropic/gateway";
import type { RunnerEvent } from "./durable-object";

/**
 * The Cloudflare runtime as a `SessionGateway`, one per agent: every call
 * reaches that agent's `AgentRunner`. Session ids are minted here, so the
 * router stores them exactly as it stores Anthropic's.
 *
 * Event ids are the runner's sequence numbers, which is what makes the
 * router's cursor work unchanged: "after this id" is a numeric comparison the
 * runner does itself.
 */

export const runnerStub = (env: Env, agentId: string) =>
  env.AGENT_RUNNER.get(env.AGENT_RUNNER.idFromName(agentId));

const toSessionEvent = (event: RunnerEvent): SessionEvent => ({
  id: String(event.seq),
  processedAt: new Date(event.at).toISOString(),
  stopReason: event.stopReason,
  text: event.text,
  type: event.type,
});

export const createRunnerGateway = (
  env: Env,
  agentId: string
): SessionGateway => {
  const stub = runnerStub(env, agentId);
  return {
    async createSession(input) {
      const sessionId = crypto.randomUUID();
      await stub.start({
        agentId,
        model: input.model,
        sessionId,
        text: input.text,
      });
      return { sessionId, status: "running" };
    },

    async deleteSession(sessionId) {
      await stub.stop(sessionId);
    },

    async getSession(sessionId) {
      return await stub.status(sessionId);
    },

    async pollEvents(sessionId, cursor) {
      const afterSeq = cursor ? Number(cursor.lastEventId) || 0 : 0;
      const events = (await stub.events(sessionId, afterSeq)).map(
        toSessionEvent
      );
      return { cursor: advanceCursor(events, cursor), events };
    },

    async sendMessage(sessionId, text) {
      await stub.send(sessionId, text);
    },
  };
};
