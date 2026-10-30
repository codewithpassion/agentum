// The viewer's choice between Mine and Everyone. The rail and the main pane
// both read it from one in-memory store, so blocked storage cannot split them.
// localStorage only persists it. The storage is passed in as a getter, because
// reading `window.localStorage` itself throws when the browser blocks storage.

import type { RailScope } from "@repo/db/shared";

export const SCOPE_KEY = "hm:rail-scope";

type Store = Pick<Storage, "getItem" | "setItem">;

/** Everyone when that was stored, otherwise Mine. Blocked storage reads as Mine. */
export const readScope = (storage: () => Store): RailScope => {
  try {
    return storage().getItem(SCOPE_KEY) === "everyone" ? "everyone" : "mine";
  } catch {
    return "mine";
  }
};

/** Keeps the choice. When storage is blocked it is not kept, and the next read says Mine. */
export const writeScope = (storage: () => Store, scope: RailScope): void => {
  try {
    storage().setItem(SCOPE_KEY, scope);
  } catch {
    // Storage is blocked, so the choice is not kept.
  }
};

/**
 * The choice held in memory, read from storage once and written through to it.
 * `subscribe` tells the rail and the pane when it changes.
 */
export const createScopeStore = (storage: () => Store) => {
  let current: RailScope | null = null;
  const listeners = new Set<() => void>();
  return {
    get: (): RailScope => {
      current ??= readScope(storage);
      return current;
    },
    set: (scope: RailScope): void => {
      if (current === scope) {
        return;
      }
      current = scope;
      writeScope(storage, scope);
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/** The app's store, over the browser's localStorage. */
export const railScope = createScopeStore(() => window.localStorage);
