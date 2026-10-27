// Response headers for pages the app serves itself (R1.21a). Artifact content
// under /a/<uuid>/c/ sets its own `frame-ancestors`, so it passes through. Every
// other response may not be framed, and the viewer and share pages send no
// Referer, because their URLs can carry a share token.
import type { MiddlewareHandler } from "hono/types";

const CONTENT_PATH = /^\/a\/[^/]+\/c(\/|$)/;
const NO_REFERRER_PATH = /^\/(a|s)\//;
const SWITCHING_PROTOCOLS = 101;

const exempt = (status: number, pathname: string): boolean =>
  CONTENT_PATH.test(pathname) || status === SWITCHING_PROTOCOLS;

/** Adds the frame and referrer headers `pathname` needs to a mutable `headers`. */
const addGuardHeaders = (headers: Headers, pathname: string): void => {
  // Appended, not set: a route that sends its own CSP (`/files/:id`) keeps it.
  headers.append("Content-Security-Policy", "frame-ancestors 'none'");
  if (NO_REFERRER_PATH.test(pathname)) {
    headers.set("Referrer-Policy", "no-referrer");
  }
};

export const frameGuard: MiddlewareHandler = async (c, next) => {
  await next();
  const { pathname } = new URL(c.req.url);
  if (exempt(c.res.status, pathname)) {
    return;
  }
  // Hono copies the old response's headers over a new one's on assignment, so
  // the headers go on after the response is replaced.
  c.res = new Response(c.res.body, c.res);
  addGuardHeaders(c.res.headers, pathname);
};
