/**
 * Where a secret may be sent: parsing the owner's allowlist, and matching a
 * request's hostname against it.
 *
 * One module, used by three callers that must agree exactly - the route that
 * validates what an owner typed, the `http_request` tool that refuses a
 * mismatch before any request is made, and the vault mirror that hands the
 * same list to Anthropic as a credential's `networking.allowed_hosts`. Host
 * logic in two places is host logic that disagrees, and a disagreement here is
 * a key sent somewhere its owner did not allow.
 *
 * Everything is pure, so the rules are testable without a request.
 *
 * `modules/browser/rules.ts` guards URLs for the browser tools and shares the
 * reserved IPv4 ranges below, but nothing else: it accepts `http:`, it takes
 * whole URLs, and its `isPrivateIpv4` is private to that file. This is its own
 * thing, and deliberately stricter.
 */

/** Anthropic's cap on a vault credential's `networking.allowed_hosts`. */
export const MAX_ALLOWED_HOSTS = 16;

/** Long enough for any real hostname (RFC 1035 caps a name at 253). */
const MAX_HOST_LENGTH = 253;

const WILDCARD_PREFIX = "*.";
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** One DNS label: alphanumerics and inner hyphens, per RFC 1123. */
const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const TRAILING_DOT = /\.$/;

const MAX_OCTET = 255;
const CARRIER_GRADE_NAT_MIN = 64;
const CARRIER_GRADE_NAT_MAX = 127;
const PRIVATE_172_MIN = 16;
const PRIVATE_172_MAX = 31;
const LINK_LOCAL_SECOND_OCTET = 254;

/** Hostnames that resolve to somebody's own network rather than the internet. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * Reserved IPv4 ranges: loopback, RFC1918, link-local (cloud metadata) and
 * CGNAT. The same set `modules/browser/rules.ts` refuses; it cannot be imported
 * from there, so the ranges are restated rather than half-shared.
 */
const isPrivateIpv4 = (hostname: string): boolean => {
  const match = IPV4.exec(hostname);
  if (!match) {
    return false;
  }
  const octets = match.slice(1, 5).map(Number);
  const [first, second] = octets;
  if (
    first === undefined ||
    second === undefined ||
    octets.some((octet) => octet > MAX_OCTET)
  ) {
    return false;
  }
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

const isIpv4 = (hostname: string): boolean =>
  IPV4.exec(hostname)
    ?.slice(1, 5)
    .every((o) => Number(o) <= MAX_OCTET) ?? false;

/**
 * Whether a hostname belongs to somebody's own network rather than the public
 * internet - loopback, RFC1918, link-local (cloud metadata), CGNAT, and the
 * `.local`-style suffixes.
 *
 * Exported because the `http_request` tool needs exactly this guard on the
 * path where no secret is named: there is no allowlist to check against, and
 * the request is still a server-side fetch from our network. `browser/rules.ts`
 * has
 * the equivalent for URLs, but it is not importable and it accepts `http:`, so
 * this is the one exported form - a third copy is what this module exists to
 * prevent.
 *
 * Expects a bare hostname, as `URL.hostname` gives it. It resolves no DNS - a
 * Worker cannot - so a public name pointed at 127.0.0.1 still passes, which is
 * the same limitation the browser guard documents.
 */
export const isPrivateHost = (hostname: string): boolean => {
  const host = hostname.trim().toLowerCase().replace(TRAILING_DOT, "");
  return (
    host === "localhost" ||
    PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
    isPrivateIpv4(host)
  );
};

export type AllowedHostResult =
  | { ok: true; host: string }
  | { ok: false; reason: string };

const refuse = (reason: string): AllowedHostResult => ({ ok: false, reason });

const labelsValid = (hostname: string): boolean =>
  hostname.split(".").every((label) => LABEL.test(label));

/**
 * One entry of an owner's allowlist, normalized.
 *
 * Accepted: a bare hostname (`api.deepgram.com`), a public IPv4 literal, or a
 * `*.`-prefixed wildcard (`*.deepgram.com`). Normalization lowercases and
 * drops one trailing dot, so `API.Deepgram.com.` and `api.deepgram.com` cannot
 * become two entries that behave differently.
 *
 * Refused, and each for its own reason:
 * - schemes, ports, paths, userinfo and IPv6 - Anthropic's `allowed_hosts`
 *   takes none of them, and accepting one here would silently mean something
 *   different on each of the three paths that read this list;
 * - private, loopback, link-local and CGNAT addresses, and the `.local`-style
 *   suffixes - a secret allowlisted to an internal address is an SSRF primitive
 *   with a credential attached;
 * - a single-label name (`intranet`) - it only resolves through an internal
 *   search domain, so it is private by construction;
 * - `*.com` and friends - a wildcard over a public suffix is "anywhere"
 *   wearing an allowlist, and the whole point of this list is that it is not.
 */
/**
 * Everything that means "this is not a bare host at all" - a URL, a port, a
 * path, userinfo, an IPv6 literal. Split out so `parseAllowedHost` is left with
 * the rules that are actually about hostnames.
 *
 * `entry` is the caller's original text, quoted back so the message names what
 * they typed rather than what it normalized to.
 */
const refuseNonHostShape = (
  trimmed: string,
  entry: string
): AllowedHostResult | null => {
  if (trimmed.length === 0) {
    return refuse("A host is required.");
  }
  if (trimmed.length > MAX_HOST_LENGTH) {
    return refuse(`Hosts must be at most ${MAX_HOST_LENGTH} characters.`);
  }
  if (trimmed.includes("://")) {
    return refuse(
      `"${entry}" looks like a URL. Use the host on its own, e.g. api.deepgram.com.`
    );
  }
  if (trimmed.includes("/")) {
    return refuse(`"${entry}" must not include a path.`);
  }
  if (trimmed.includes("@")) {
    return refuse(`"${entry}" must not include credentials.`);
  }
  if (trimmed.includes(":")) {
    // Both a port and an IPv6 literal land here, and neither is representable.
    return refuse(
      `"${entry}" must not include a port, and IPv6 is not supported.`
    );
  }
  return null;
};

export const parseAllowedHost = (entry: string): AllowedHostResult => {
  const trimmed = entry.trim().toLowerCase().replace(TRAILING_DOT, "");
  const malformed = refuseNonHostShape(trimmed, entry);
  if (malformed) {
    return malformed;
  }

  const wildcard = trimmed.startsWith(WILDCARD_PREFIX);
  const hostname = wildcard ? trimmed.slice(WILDCARD_PREFIX.length) : trimmed;

  if (hostname.includes("*")) {
    return refuse(
      `"${entry}" may only use a wildcard as a leading "*.", e.g. *.deepgram.com.`
    );
  }
  if (hostname.length === 0 || !labelsValid(hostname)) {
    return refuse(`"${entry}" is not a valid hostname.`);
  }

  if (isIpv4(hostname)) {
    if (wildcard) {
      return refuse("A wildcard cannot be used with an IP address.");
    }
    if (isPrivateIpv4(hostname)) {
      return refuse(
        `${hostname} is a private or loopback address, which a secret may not be sent to.`
      );
    }
    return { host: hostname, ok: true };
  }

  // One check covers two refusals that happen to have the same shape: a bare
  // `intranet`, and `*.com` - a wildcard over a bare TLD, which is every host
  // on the internet wearing an allowlist. Judged by label count rather than by
  // a public-suffix list, which would be a dependency and a staleness problem
  // for a rule this blunt.
  if (hostname.split(".").length < 2) {
    return refuse(
      wildcard
        ? `"${entry}" is too broad - wildcard at least one level down, e.g. *.deepgram.com.`
        : `"${entry}" is a single-label name, which only resolves on a private network. Use a fully qualified host.`
    );
  }
  if (isPrivateHost(hostname)) {
    return refuse(
      `${hostname} is a private or loopback name, which a secret may not be sent to.`
    );
  }

  return {
    host: wildcard ? `${WILDCARD_PREFIX}${hostname}` : hostname,
    ok: true,
  };
};

export type AllowedHostsResult =
  | { ok: true; hosts: string[] }
  | { ok: false; reason: string };

/**
 * A whole allowlist. Deduplicated after normalization, so the same host typed
 * two ways does not spend two of the sixteen slots.
 */
export const parseAllowedHosts = (
  entries: readonly string[]
): AllowedHostsResult => {
  if (entries.length === 0) {
    return {
      ok: false,
      reason:
        "At least one allowed host is required - a secret with none can never be used.",
    };
  }
  if (entries.length > MAX_ALLOWED_HOSTS) {
    return {
      ok: false,
      reason: `A secret may allow at most ${MAX_ALLOWED_HOSTS} hosts.`,
    };
  }

  const hosts: string[] = [];
  for (const entry of entries) {
    const parsed = parseAllowedHost(entry);
    if (!parsed.ok) {
      return { ok: false, reason: parsed.reason };
    }
    if (!hosts.includes(parsed.host)) {
      hosts.push(parsed.host);
    }
  }
  return { hosts, ok: true };
};

/**
 * Whether a request's hostname is covered by the secret's allowlist.
 *
 * Exact match, or a `*.` wildcard over a **strict** subdomain. Two things this
 * deliberately does not do:
 *
 * - it never compares with `endsWith` on the bare host, which is the classic
 *   hole: `evil-api.deepgram.com` ends with `api.deepgram.com` and is a host
 *   an attacker can register. A wildcard matches on label boundaries only.
 * - `*.deepgram.com` does **not** match `deepgram.com` itself. An owner who
 *   wants the apex adds it, which keeps "the wildcard entry" and "the apex" two
 *   visible decisions rather than one entry quietly meaning both.
 *
 * The hostname is expected to come from `URL.hostname` (already lowercased,
 * already free of port and path); it is lowercased again rather than trusted.
 */
export const hostMatches = (
  hostname: string,
  allowed: readonly string[]
): boolean => {
  const host = hostname.trim().toLowerCase().replace(TRAILING_DOT, "");
  if (host.length === 0) {
    return false;
  }
  return allowed.some((entry) => {
    const candidate = entry.trim().toLowerCase();
    if (!candidate.startsWith(WILDCARD_PREFIX)) {
      return candidate === host;
    }
    // The dot is kept in the suffix, so only a real label boundary matches.
    const suffix = candidate.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  });
};
