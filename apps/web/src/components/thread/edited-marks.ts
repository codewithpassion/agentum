// The user messages the browser tab edited and resent (V2.12). No event
// records an edit, so the mark lives in sessionStorage, which survives the
// remount when the page moves to the new run. Storage can be missing or throw
// (private windows, blocked site data), so every access is guarded and the
// page works without it.

export interface MarkStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const KEY = "agentum:edited-messages";

const resolve = (
  storage: MarkStorage | null | undefined
): MarkStorage | null => {
  if (storage !== undefined) {
    return storage;
  }
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

const readIds = (storage: MarkStorage | null): string[] => {
  if (storage === null) {
    return [];
  }
  try {
    const raw = storage.getItem(KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

export const readEditedMarks = (
  storage?: MarkStorage | null
): ReadonlySet<string> => new Set(readIds(resolve(storage)));

export const addEditedMark = (
  id: string,
  storage?: MarkStorage | null
): void => {
  const target = resolve(storage);
  if (target === null) {
    return;
  }
  try {
    const ids = new Set(readIds(target));
    ids.add(id);
    target.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    // Storage is full or blocked. The mark is then kept for this render only.
  }
};
