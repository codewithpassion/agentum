/**
 * What a person's hand-back reports to the takeover flow. An agent that asked a
 * person to take over waits on this; the flow that settles it is not built yet,
 * so until it is, a hand-back has nothing to settle.
 */
export interface HandBackEvent {
  agentId: string;
  note: string | null;
  userId: string;
  workspaceId: string;
}

export type HandBackHook = (event: HandBackEvent) => Promise<void>;

export const onHandBack: HandBackHook = () => Promise.resolve();
