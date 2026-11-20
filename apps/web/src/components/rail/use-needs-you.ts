import type { RailItem, RailScope, RailView } from "@repo/db/shared";
import { useRouterState } from "@tanstack/react-router";
import { usePolledQuery } from "#/components/inbox/use-polled-query";
import { useTaskControl } from "#/components/task/task-control.ts";
import { getTrpc } from "#/integrations/trpc/client";
import { actionableNeedsYou } from "./rail-logic.ts";
import { useRail, useRailScope } from "./use-rail.ts";

const MEMBERS_POLL_MS = 5 * 60_000;

export interface NeedsYouState {
  actionable: RailItem[];
  /** Null until the first answer, else the number of actionable items. */
  count: number | null;
  error: string | null;
  fresh: ReadonlySet<string>;
  openId: string | null;
  scope: RailScope | null;
  setScope: (scope: RailScope) => void;
  showToggle: boolean;
  view: RailView | null;
}

/** The item the main pane has open, from `/desk?item=...`. */
function useOpenItemId(): string | null {
  const location = useRouterState({ select: (state) => state.location });
  const { item } = location.search as { item?: unknown };
  return location.pathname === "/desk" && typeof item === "string"
    ? item
    : null;
}

/** The Needs you list for the person's scope, live whether or not the drawer is open. */
export function useNeedsYou(): NeedsYouState {
  const openId = useOpenItemId();
  const { scope: chosenScope, setScope } = useRailScope();
  const { data: members } = usePolledQuery(
    () => getTrpc().members.list.query(),
    null,
    MEMBERS_POLL_MS
  );
  // A one-person workspace has no toggle, so a stored Everyone must not stick.
  const scope = members?.length === 1 ? "mine" : chosenScope;
  const { error, fresh, needsYou, view } = useRail(scope, openId);
  const control = useTaskControl();
  const actionable = actionableNeedsYou(needsYou, control?.requestId);
  // A failed member lookup keeps the toggle: hiding it would hide Everyone.
  const showToggle = members === null || members.length > 1;

  return {
    actionable,
    count: view === null ? null : actionable.length,
    error,
    fresh,
    openId,
    scope,
    setScope,
    showToggle,
    view,
  };
}
