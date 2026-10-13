/**
 * Asks an agent's rail to show its Screen tab. The card that wants it sits in
 * the conversation, and the tab lives in the rail, so the two meet on the
 * window rather than through props threaded down the message list.
 */

export const OPEN_AGENT_SCREEN_EVENT = "agentum:open-agent-screen";

export interface OpenAgentScreenDetail {
  agentId: string;
}

export const requestOpenAgentScreen = (agentId: string): void => {
  window.dispatchEvent(
    new CustomEvent<OpenAgentScreenDetail>(OPEN_AGENT_SCREEN_EVENT, {
      detail: { agentId },
    })
  );
};

/** Whether a window event asks for this agent's screen. */
export const isOpenScreenRequestFor = (
  event: Event,
  agentId: string
): boolean =>
  event instanceof CustomEvent &&
  (event.detail as Partial<OpenAgentScreenDetail> | null)?.agentId === agentId;
