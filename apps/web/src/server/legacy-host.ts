// The old hostnames (harbourmaster.rockyshoreslabs.io and its staging twin) stay
// attached to this Worker after the move to Agentum v2, listed in LEGACY_HOSTS.
// A person opening a page there gets a 301 to the same path on PUBLIC_BASE_URL.
// Everything else is served in place: installed daemons and computer clients
// hold the old URL and dial WebSockets that follow no redirect, and API callers,
// A2A peers, webhooks and `curl | sh` installs would lose their Authorization
// header or their body on a cross-origin redirect. Empty LEGACY_HOSTS turns it off.
import type { MiddlewareHandler } from "hono/types";

const MOVED_PERMANENTLY = 301;

export interface LegacyRequest {
  accept: string | null;
  method: string;
  upgrade: string | null;
  url: string;
}

const hostsOf = (list: string | undefined): Set<string> =>
  new Set(
    (list ?? "")
      .split(",")
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean)
  );

/**
 * Where to send a request that reached a legacy host, or null to serve it.
 * Only a browser page load moves: GET or HEAD, asking for HTML, no upgrade.
 */
export const legacyRedirect = (
  request: LegacyRequest,
  legacyHosts: string | undefined,
  publicBaseUrl: string | undefined
): string | null => {
  if (!publicBaseUrl) {
    return null;
  }
  const url = new URL(request.url);
  const target = new URL(publicBaseUrl);
  if (
    !hostsOf(legacyHosts).has(url.hostname) ||
    url.hostname === target.hostname
  ) {
    return null;
  }
  const page =
    (request.method === "GET" || request.method === "HEAD") &&
    request.upgrade === null &&
    (request.accept ?? "").includes("text/html");
  return page ? `${target.origin}${url.pathname}${url.search}` : null;
};

export const legacyHost: MiddlewareHandler<{ Bindings: Env }> = async (
  c,
  next
) => {
  const location = legacyRedirect(
    {
      accept: c.req.header("Accept") ?? null,
      method: c.req.method,
      upgrade: c.req.header("Upgrade") ?? null,
      url: c.req.url,
    },
    c.env.LEGACY_HOSTS,
    c.env.PUBLIC_BASE_URL
  );
  if (location) {
    return c.redirect(location, MOVED_PERMANENTLY);
  }
  await next();
};
