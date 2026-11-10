import { useMatches } from "@tanstack/react-router";

export const isTaskLayout = (routeIds: readonly string[]): boolean =>
  routeIds.includes("/_app/threads/$sessionId");

/** Tasks supply their own header and fill the space below the site header. */
export function useTaskLayout(): boolean {
  return useMatches({
    select: (matches) => isTaskLayout(matches.map((match) => match.routeId)),
  });
}
