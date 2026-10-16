import { useMatches } from "@tanstack/react-router";

/** True on signed-in pages, the ones rendered inside the `_app` shell. */
export function useIsAppShell(): boolean {
  return useMatches({
    select: (matches) => matches.some((match) => match.routeId === "/_app"),
  });
}
