import {
  RAIL_REFRESH_EVENT,
  RAIL_SCOPE_EVENT,
  type RailItem,
  type RailScope,
  type RailView,
} from "@repo/db/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { localMidnightIso } from "#/components/desk/desk-logic";
import {
  DESK_POLL_INTERVAL_MS,
  usePolledQuery,
} from "#/components/inbox/use-polled-query";
import { getTrpc } from "#/integrations/trpc/client";
import { freshIds, stableOrder } from "./stable-order.ts";

const SCOPE_STORAGE_KEY = "hm:rail-scope";

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

const isScope = (value: string | null): value is RailScope =>
  value === "mine" || value === "everyone";

/**
 * The person's chosen scope, kept in localStorage. It is null until the
 * stored choice has been read, so the rail does not fetch the wrong scope first.
 */
export function useRailScope() {
  const [scope, setScopeState] = useState<RailScope | null>(null);

  useEffect(() => {
    const read = () => {
      let stored: string | null = null;
      try {
        stored = window.localStorage.getItem(SCOPE_STORAGE_KEY);
      } catch {
        // Storage can be blocked. Mine is the default.
      }
      setScopeState(isScope(stored) ? stored : "mine");
    };
    read();
    // The main pane can switch the scope too, for a link to a teammate's item.
    window.addEventListener(RAIL_SCOPE_EVENT, read);
    return () => window.removeEventListener(RAIL_SCOPE_EVENT, read);
  }, []);

  const setScope = useCallback((next: RailScope) => {
    setScopeState(next);
    try {
      window.localStorage.setItem(SCOPE_STORAGE_KEY, next);
    } catch {
      // The choice then lasts for this visit only.
    }
    // The main pane reads the stored scope on its next fetch.
    window.dispatchEvent(new Event(RAIL_REFRESH_EVENT));
  }, []);

  return { scope, setScope };
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
