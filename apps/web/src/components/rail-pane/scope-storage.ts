// Where the rail keeps the viewer's choice between Mine and Everyone. The
// storage is passed in as a getter, because reading `window.localStorage`
// itself throws when the browser blocks storage.

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

/** Keeps the choice. When storage is blocked, the choice lasts for this visit only. */
export const writeScope = (storage: () => Store, scope: RailScope): void => {
  try {
    storage().setItem(SCOPE_KEY, scope);
  } catch {
    // Storage is blocked, so the choice is not kept.
  }
};
