// The header wrapper every response under /a/<uuid>/c/ passes through
// (PRD section 3, "The design"). One place sets the sandbox CSP, so a status
// code that forgets it cannot exist: the route builds bare responses and
// `withContentHeaders` finishes each of them.

/** Script hosts an artifact page may load libraries from. */
export const CONTENT_SCRIPT_CDNS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://unpkg.com",
  "https://cdn.tailwindcss.com",
  "https://code.jquery.com",
] as const;

const STYLE_HOSTS = ["https://fonts.googleapis.com"] as const;
const FONT_HOSTS = ["https://fonts.gstatic.com"] as const;

export interface ContentCspInput {
  /** `https://<app>`, the origin the request came to. Goes in `frame-ancestors`. */
  appOrigin: string;
  /**
   * This version's content folder, `https://<app>/a/<uuid>/c/<token>/`, with
   * the trailing slash: a CSP host source with a path ending in `/` matches
   * only that prefix. Null when the URL didn't parse, so no folder is allowed.
   */
  contentBase: string | null;
}

/**
 * The full content CSP. `'self'` is never used: in an opaque-origin document
 * it may match nothing or more than intended, so every source is explicit.
 */
export const buildContentCsp = (input: ContentCspInput): string => {
  const base = input.contentBase ? [input.contentBase] : [];
  const sources = (...extra: readonly string[]) =>
    [...base, ...extra].join(" ");
  const withBase = (...extra: readonly string[]) => {
    const list = sources(...extra);
    return list === "" ? "'none'" : list;
  };
  return [
    "sandbox allow-scripts allow-forms",
    "default-src 'none'",
    `script-src ${sources("'unsafe-inline'", ...CONTENT_SCRIPT_CDNS)}`,
    `style-src ${sources("'unsafe-inline'", ...STYLE_HOSTS)}`,
    `font-src ${sources(...FONT_HOSTS)}`,
    `img-src ${sources("data:", "blob:")}`,
    `connect-src ${withBase()}`,
    `media-src ${withBase()}`,
    "form-action 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    `frame-ancestors ${input.appOrigin}`,
  ].join("; ");
};

/**
 * Wrap a response so it carries the content headers, whatever its status.
 * Builds a new Response, because redirects and fetched bodies have immutable
 * headers. Never sets `Service-Worker-Allowed` and drops it if present.
 */
export const withContentHeaders = (
  response: Response,
  input: ContentCspInput
): Response => {
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", buildContentCsp(input));
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "private, max-age=300");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.delete("Access-Control-Allow-Credentials");
  headers.delete("Service-Worker-Allowed");
  headers.delete("Set-Cookie");
  // The answer depends on how the request was made (302 for a top-level open,
  // the file for a frame load), so a browser cache must not mix them.
  headers.append("Vary", "Sec-Fetch-Dest");
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
};
