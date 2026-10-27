import { useMatches } from "@tanstack/react-router";

const FULL_BLEED_ROUTE_IDS = new Set(["/a/$artifactId", "/s/$token"]);

/**
 * True on the artifact viewer and the share page. They fill the viewport, so
 * the site header and footer stay out.
 */
export function useIsFullBleed(): boolean {
  return useMatches({
    select: (matches) =>
      matches.some((match) => FULL_BLEED_ROUTE_IDS.has(match.routeId)),
  });
}
