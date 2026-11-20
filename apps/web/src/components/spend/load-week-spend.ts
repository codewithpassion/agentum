import { getTrpc } from "#/integrations/trpc/client";
import { spendWeeks, weekCentsByAgent } from "./spend-logic.ts";

/**
 * This week's cents per agent, read from the same `spend.workspace` rows the
 * Spend page adds up. A failed read gives an empty map, so a page that shows
 * the figure still loads.
 */
export const loadWeekSpend = async (): Promise<Map<string, number>> => {
  try {
    const trpc = getTrpc();
    const { timezone } = await trpc.workspaces.timezone.query();
    const week = spendWeeks(new Date(), timezone).at(-1);
    if (!week) {
      return new Map();
    }
    const rows = await trpc.spend.workspace.query({
      from: week.start,
      to: week.end,
    });
    return weekCentsByAgent(rows);
  } catch {
    return new Map();
  }
};
