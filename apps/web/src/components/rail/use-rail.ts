import {
  RAIL_REFRESH_EVENT,
  type RailItem,
  type RailScope,
  type RailView,
} from "@repo/db/shared";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { localMidnightIso } from "#/components/desk/desk-logic";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query";
import { railScope } from "#/components/rail-pane/scope-storage.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { freshIds, stableOrder } from "./stable-order.ts";

interface Loaded {
  scope: RailScope;
  view: RailView;
}

interface Shown {
  fresh: ReadonlySet<string>;
  items: RailItem[];
  source: Loaded | null;
}

const NOTHING_SHOWN: Shown = { fresh: new Set(), items: [], source: null };

const NO_SCOPE_YET = (): null => null;

/**
 * The person's chosen scope, from the store the main pane reads too. It is
 * null on the server and until hydration, so the rail does not fetch the wrong
 * scope first.
 */
export function useRailScope(): {
  scope: RailScope | null;
  setScope: (scope: RailScope) => void;
} {
  const scope = useSyncExternalStore<RailScope | null>(
    railScope.subscribe,
    railScope.get,
    NO_SCOPE_YET
  );
  return { scope, setScope: railScope.set };
}

const loadRail = async (scope: RailScope | null): Promise<Loaded | null> => {
  if (scope === null) {
    return null;
  }
  const view = await getTrpc().desk.rail.query({
    dayStart: localMidnightIso(new Date()),
    scope,
  });
  return { scope, view };
};

/**
 * The rail's data for a scope, polled, and refetched on RAIL_REFRESH_EVENT.
 * Needs you keeps the open row where it is while other rows come and go.
 */
export function useRail(scope: RailScope | null, openId: string | null) {
  const { data, error, refresh } = usePolledQuery(
    () => loadRail(scope),
    null,
    DESK_POLL_INTERVAL_MS
  );

  const shownScope = useRef(scope);
  useEffect(() => {
    if (shownScope.current !== scope) {
      shownScope.current = scope;
      refresh();
    }
  }, [scope, refresh]);

  useEffect(() => {
    window.addEventListener(RAIL_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(RAIL_REFRESH_EVENT, refresh);
  }, [refresh]);

  const [shown, setShown] = useState<Shown>(NOTHING_SHOWN);
  if (data !== null && data !== shown.source) {
    // Another scope is a different list, so nothing holds still or rises.
    const previousIds =
      shown.source?.scope === data.scope
        ? shown.items.map((item) => item.id)
        : [];
    const items = stableOrder(previousIds, data.view.needsYou, openId);
    setShown({ fresh: freshIds(previousIds, items), items, source: data });
  }

  // Until the other scope's answer arrives, the rail shows it as loading.
  const current = data?.scope === scope ? data : null;
  return {
    error,
    fresh: shown.fresh,
    needsYou: current === null ? [] : shown.items,
    view: current?.view ?? null,
  };
}
