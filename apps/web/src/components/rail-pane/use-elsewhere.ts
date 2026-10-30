// Where an item the URL names is, when the scope on screen does not list it.

import type { RailScope } from "@repo/db/shared";
import { useEffect, useState } from "react";
import { localMidnightIso } from "#/components/desk/desk-logic.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { isListed } from "./pane-logic.ts";

/** Under Everyone, gone from both scopes, or the check failed. */
export type Elsewhere = "everyone" | "gone" | "failed";

/**
 * Checks Everyone once for each missing id, outside the poll. The caller passes
 * an id only once a list loaded after the id was opened lacks it, so the scope
 * on screen is known to be without it. Everyone holds everything Mine does, so
 * it is the one other place to look. Null while the check runs.
 */
export function useElsewhere(
  missing: string | null,
  scope: RailScope | null
): Elsewhere | null {
  const [checked, setChecked] = useState<{
    id: string;
    result: Elsewhere;
  } | null>(null);
  // A verdict belongs to one opening of one id under one scope. Opening the id
  // again starts from no verdict, so an old one is never shown while the new
  // check runs.
  const key = missing === null ? null : `${missing}|${scope}`;
  const [lastKey, setLastKey] = useState(key);
  if (lastKey !== key) {
    setLastKey(key);
    setChecked(null);
  }

  useEffect(() => {
    if (missing === null || scope !== "mine") {
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const everyone = await getTrpc().desk.rail.query({
          dayStart: localMidnightIso(new Date()),
          scope: "everyone",
        });
        if (!cancelled) {
          setChecked({
            id: missing,
            result: isListed(everyone, missing) ? "everyone" : "gone",
          });
        }
      } catch {
        if (!cancelled) {
          setChecked({ id: missing, result: "failed" });
        }
      }
    };
    check();
    return () => {
      cancelled = true;
    };
  }, [missing, scope]);

  if (missing === null) {
    return null;
  }
  if (scope === "everyone") {
    return "gone";
  }
  return checked?.id === missing ? checked.result : null;
}
