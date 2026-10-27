/**
 * Header rules for the answers of an app's server part. App code chooses its
 * own response headers, so only an allowlist is copied: `Set-Cookie`,
 * `Clear-Site-Data`, `Service-Worker-Allowed` and CORS headers from the app
 * never reach the browser (`docs/v3/phase2-spike.md` Q3). The content wrapper
 * from A.4 then sets the CSP and the rest over the top.
 */

const COPIED_RESPONSE_HEADERS = [
  "content-type",
  "content-length",
  "content-encoding",
  "etag",
  "vary",
] as const;

/** Headers a page's request carries that the app's code never needs. */
const DROPPED_REQUEST_HEADERS = ["cookie", "authorization", "service-worker"];

const PREFLIGHT_MAX_AGE_SECONDS = "600";
const PREFLIGHT_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const DEFAULT_PREFLIGHT_HEADERS = "content-type";
const BODYLESS = new Set([101, 204, 205, 304]);

/** The headers of the app's answer that pass through. */
export const copiedResponseHeaders = (from: Headers): Headers => {
  const headers = new Headers();
  for (const name of COPIED_RESPONSE_HEADERS) {
    const value = from.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return headers;
};

/** The app's answer reduced to status, body and the allowlisted headers. */
export const filteredResponse = (answer: Response): Response => {
  const status =
    answer.status >= 200 && answer.status <= 599 ? answer.status : 502;
  return new Response(BODYLESS.has(status) ? null : answer.body, {
    headers: copiedResponseHeaders(answer.headers),
    status,
  });
};

/** The request headers the app sees. */
export const forwardedRequestHeaders = (from: Headers): Headers => {
  const headers = new Headers(from);
  for (const name of DROPPED_REQUEST_HEADERS) {
    headers.delete(name);
  }
  return headers;
};

/**
 * The answer to a CORS preflight for `/api/*`. The page is in an opaque
 * origin, so the wildcard is what lets it call; with no credentials header
 * the browser sends no cookies, and the token in the path is what grants access.
 */
export const preflightResponse = (request: Request): Response =>
  new Response(null, {
    headers: {
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") ??
        DEFAULT_PREFLIGHT_HEADERS,
      "Access-Control-Allow-Methods": PREFLIGHT_METHODS,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Max-Age": PREFLIGHT_MAX_AGE_SECONDS,
    },
    status: 204,
  });
