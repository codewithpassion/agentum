import { useMatches } from "@tanstack/react-router";

const FULL_BLEED_ROUTE_IDS = new Set([
  "/",
  "/a/$artifactId",
  "/login",
  "/s/$token",
  "/sign-up",
]);

/**
 * True on pages that bring their own chrome, so the site header and footer
 * stay out: the artifact viewer and the share page fill the viewport, and the
 * landing, sign-in and sign-up pages use the landing module's public shell.
 */
export function useIsFullBleed(): boolean {
  return useMatches({
    select: (matches) =>
      matches.some((match) => FULL_BLEED_ROUTE_IDS.has(match.routeId)),
  });
}
