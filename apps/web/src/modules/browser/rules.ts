/**
 * What an agent is allowed to ask its browser to do. The browser runs on
 * Cloudflare's network with no network policy of our own around it, so a URL an
 * agent invents is a server-side fetch we are lending our credentials-free but
 * still privileged position to - hence the SSRF guard here rather than in a
 * route. Everything in this file is pure so it can be tested without a browser.
 */

export const MAX_URL_LENGTH = 2048;
export const MAX_SELECTOR_LENGTH = 500;
export const MAX_FILL_VALUE_LENGTH = 10_000;

/**
 * How long Browser Run keeps an idle session alive for us. It is also our idle
 * close: the platform ends the session this long after the agent's last tool
 * call, so nothing of ours has to run a timer. 2.5 minutes is inside the
 * 10s-600s the API accepts, and short enough to be polite about the beta's
 * concurrency limits.
 */
export const KEEP_ALIVE_MS = 150_000;

/**
 * A session close and our clock disagree slightly, and a doomed reconnect costs
 * a round trip before it fails. Anything this close to the deadline is treated
 * as already gone.
 */
const STALE_MARGIN_MS = 10_000;

export type UrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

const CARRIER_GRADE_NAT_MIN = 64;
const CARRIER_GRADE_NAT_MAX = 127;
const PRIVATE_172_MIN = 16;
const PRIVATE_172_MAX = 31;
const LINK_LOCAL_SECOND_OCTET = 254;

/** Reserved IPv4 ranges: loopback, RFC1918, link-local (cloud metadata), CGNAT. */
const isPrivateIpv4 = (hostname: string): boolean => {
  const match = IPV4.exec(hostname);
  if (!match) {
    return false;
  }
  const first = Number(match[1]);
  const second = Number(match[2]);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === LINK_LOCAL_SECOND_OCTET) ||
    (first === 172 && second >= PRIVATE_172_MIN && second <= PRIVATE_172_MAX) ||
    (first === 192 && second === 168) ||
    (first === 100 &&
      second >= CARRIER_GRADE_NAT_MIN &&
      second <= CARRIER_GRADE_NAT_MAX)
  );
};

const isPrivateHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix)) ||
  isPrivateIpv4(hostname);

/**
 * The one place a URL an agent supplied becomes a URL we will open. Only
 * `http` and `https`, and nothing that resolves by name or literal to our own
 * side of the network.
 *
 * Two things this deliberately does not do: it does not resolve DNS (a Worker
 * cannot, so a hostname pointed at 127.0.0.1 still passes), and it does not
 * follow the page's redirects. Both are noted rather than pretended away.
 */
export const validateUrl = (raw: unknown): UrlResult => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: "A URL is required." };
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      reason: `URLs must be at most ${MAX_URL_LENGTH} characters.`,
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return {
      ok: false,
      reason: `"${trimmed}" is not a URL. Include the scheme, e.g. https://example.com.`,
    };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason: `Only http and https URLs can be opened - got "${url.protocol}".`,
    };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs must not carry credentials." };
  }

  const hostname = url.hostname.toLowerCase();
  // `URL` brackets IPv6 literals. No public site needs to be addressed by one,
  // and enumerating the reserved IPv6 ranges is more ways to be wrong than to
  // be right, so they are refused outright.
  if (hostname.startsWith("[")) {
    return {
      ok: false,
      reason: "IPv6 literals are not allowed; use a hostname.",
    };
  }
  if (isPrivateHostname(hostname)) {
    return {
      ok: false,
      reason: `${url.hostname} is a private or loopback address, which this browser will not open.`,
    };
  }

  return { ok: true, url: url.toString() };
};

export type TextResult =
  | { ok: true; value: string }
  | { ok: false; reason: string };

/**
 * Selectors are handed to Playwright as-is, so the only rules are that one was
 * supplied and that it is not large enough to be a payload rather than a
 * selector.
 */
export const validateSelector = (raw: unknown): TextResult => {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, reason: "A CSS selector is required." };
  }
  const trimmed = raw.trim();
  if (trimmed.length > MAX_SELECTOR_LENGTH) {
    return {
      ok: false,
      reason: `Selectors must be at most ${MAX_SELECTOR_LENGTH} characters.`,
    };
  }
  return { ok: true, value: trimmed };
};

/** An empty value is legitimate here: it clears a field. */
export const validateFillValue = (raw: unknown): TextResult => {
  if (typeof raw !== "string") {
    return { ok: false, reason: "A value is required." };
  }
  if (raw.length > MAX_FILL_VALUE_LENGTH) {
    return {
      ok: false,
      reason: `Values must be at most ${MAX_FILL_VALUE_LENGTH} characters.`,
    };
  }
  return { ok: true, value: raw };
};

/**
 * Whether a recorded session is past the point where reconnecting could work.
 * A future timestamp is a clock that disagrees, not a live session from
 * tomorrow, so it is treated as current.
 */
export const isSessionStale = (lastUsedAt: number, now: number): boolean =>
  now - lastUsedAt >= KEEP_ALIVE_MS - STALE_MARGIN_MS;

/**
 * Where one screenshot lives in R2. The timestamp sorts keys the way the UI
 * reads them; the nonce keeps two screenshots taken in the same millisecond
 * from becoming one object with two rows pointing at it.
 */
export const screenshotKey = (
  agentId: string,
  takenAt: number,
  nonce: string
): string => `browser/${agentId}/${takenAt}-${nonce}.png`;
