import { useSyncExternalStore } from "react";

/** How long a notice stays up before it clears itself. */
export const SESSION_NOTICE_MS = 10_000;

/**
 * The reset notice lives outside the component that raised it, so a remount of
 * the rail or profile panel between the click and the answer cannot drop it.
 */
const notices = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

export const showSessionNotice = (
  agentId: string,
  message: string,
  durationMs: number = SESSION_NOTICE_MS
): void => {
  clearTimeout(timers.get(agentId));
  notices.set(agentId, message);
  timers.set(
    agentId,
    setTimeout(() => {
      notices.delete(agentId);
      timers.delete(agentId);
      emit();
    }, durationMs)
  );
  emit();
};

export const currentSessionNotice = (agentId: string): string | null =>
  notices.get(agentId) ?? null;

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The notice for an agent, or null once it has expired. */
export const useSessionNotice = (agentId: string): string | null =>
  useSyncExternalStore(subscribe, () => currentSessionNotice(agentId));
