// Where an item the URL names is, when the scope on screen does not list it.

import type { RailScope } from "@repo/db/shared";
import { useEffect, useState } from "react";
import { localMidnightIso } from "#/components/desk/desk-logic.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { isListed } from "./pane-logic.ts";

/** Under Everyone, gone from both scopes, or the check failed. */
export type Elsewhere = "everyone" | "gone" | "failed";

/**
 * Checks Everyone once for each missing id, outside the poll. Mine is the only
 * scope a missing item can be under, so Everyone is the one place to look.
 * Null while the check runs.
 */
export function useElsewhere(
  missing: string | null,
  scope: RailScope | null
): Elsewhere | null {
  const [checked, setChecked] = useState<{
    id: string;
    result: Elsewhere;
  } | null>(null);

  useEffect(() => {
    if (missing === null || scope !== "mine") {
      return;
    }
    const check = async () => {
      try {
        const everyone = await getTrpc().desk.rail.query({
          dayStart: localMidnightIso(new Date()),
          scope: "everyone",
        });
        setChecked({
          id: missing,
          result: isListed(everyone, missing) ? "everyone" : "gone",
        });
      } catch {
        setChecked({ id: missing, result: "failed" });
      }
    };
    check();
  }, [missing, scope]);

  if (missing === null) {
    return null;
  }
  if (scope === "everyone") {
    return "gone";
  }
  return checked?.id === missing ? checked.result : null;
}
