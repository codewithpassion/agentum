import { useEffect, useSyncExternalStore } from "react";

interface TaskControl {
  agentName: string;
  requestId: string;
  runId: string;
}
let control: TaskControl | null = null;
const listeners = new Set<() => void>();
export const taskControlSnapshot = () => control;
const serverSnapshot = () => null;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
/** Published only by a mounted task's live desktop stream, never by a run status. */
export function publishTaskControl(next: TaskControl | null) {
  control = next;
  for (const listener of listeners) {
    listener();
  }
}
export const useTaskControl = () =>
  useSyncExternalStore(subscribe, taskControlSnapshot, serverSnapshot);

export function usePublishTaskControl(
  inControl: boolean,
  agentName: string,
  requestId: string | undefined,
  runId: string
) {
  useEffect(() => {
    publishTaskControl(
      inControl && requestId ? { agentName, requestId, runId } : null
    );
    return () => publishTaskControl(null);
  }, [inControl, agentName, requestId, runId]);
}
