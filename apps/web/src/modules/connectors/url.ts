/**
 * The SSRF guard for every outbound request this module makes. Connector URLs
 * come from the human, but so do the endpoints *discovered* from them - a
 * hostile MCP server can point its protected-resource metadata at anything -
 * so discovery results are validated on exactly the same terms as the URL that
 * was pasted.
 *
 * Limitation, stated rather than hidden: a Worker cannot resolve DNS, so this
 * blocks literal private addresses and loopback names, not a public hostname
 * with an `A` record pointing at 127.0.0.1. The deeper mitigation is that
 * connector tools run on Anthropic's side, never in our Worker - what reaches
 * these endpoints from here is a metadata GET and a token POST.
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const BRACKETED_IPV6 = /^\[(.+)]$/;
const MAPPED_PREFIX = "::ffff:";
const MAPPED_IPV4_HEX = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/;
const BYTE = 256;
const LOOPBACK_NAMES = new Set(["localhost", "ip6-localhost", "ip6-loopback"]);
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
] as const;

const IPV4_OCTET_MAX = 255;
const LINK_LOCAL_SECOND_OCTET = 254;
const CARRIER_NAT_LOW = 64;
const CARRIER_NAT_HIGH = 127;
const PRIVATE_172_LOW = 16;
const PRIVATE_172_HIGH = 31;

export class InvalidConnectorUrlError extends Error {}

/**
 * The one hole in the guard, and it is not one a deployment can open: the
 * Playwright suite talks to stub MCP servers on loopback, which everything
 * below exists to reject. `--mode e2e` is the same switch that keeps the suite
 * off the real Anthropic API (`modules/anthropic/service.ts`), and it is
 * resolved when the bundle is built - a production build has no branch here to
 * turn on, whatever the environment says.
 */
const E2E_MODE = "e2e";
const E2E_LOOPBACK_HOST = "127.0.0.1";

const isE2eLoopback = (url: URL): boolean =>
  import.meta.env.MODE === E2E_MODE &&
  url.protocol === "http:" &&
  url.hostname === E2E_LOOPBACK_HOST;

const reject = (reason: string): never => {
  throw new InvalidConnectorUrlError(reason);
};

/** RFC 1918 and friends, plus loopback, link-local, CGNAT and multicast. */
const isPrivateIpv4 = (octets: readonly number[]): boolean => {
  const [a = 0, b = 0] = octets;
  if (a === 10 || a === 0 || a === 127) {
    return true;
  }
  if (a === 172 && b >= PRIVATE_172_LOW && b <= PRIVATE_172_HIGH) {
    return true;
  }
  if (a === 192 && (b === 168 || b === 0)) {
    return true;
  }
  if (a === 169 && b === LINK_LOCAL_SECOND_OCTET) {
    return true;
  }
  if (a === 100 && b >= CARRIER_NAT_LOW && b <= CARRIER_NAT_HIGH) {
    return true;
  }
  // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved, which includes broadcast.
  return a >= 224;
};

/**
 * An IPv4-mapped address is the same host by another name, and `new URL()`
 * rewrites the readable spelling (`::ffff:127.0.0.1`) into hex groups
 * (`::ffff:7f00:1`) before we ever see it - so the hex form is what must be
 * unpacked back into octets.
 */
const mappedIpv4Octets = (address: string): number[] | null => {
  const readable = IPV4.exec(address.replace(MAPPED_PREFIX, ""));
  if (readable) {
    return readable.slice(1).map(Number);
  }
  const hex = MAPPED_IPV4_HEX.exec(address);
  if (!hex) {
    return null;
  }
  const [high, low] = hex.slice(1).map((group) => Number.parseInt(group, 16));
  return [
    Math.floor((high ?? 0) / BYTE),
    (high ?? 0) % BYTE,
    Math.floor((low ?? 0) / BYTE),
    (low ?? 0) % BYTE,
  ];
};

/** `::1`, `::`, unique-local (`fc00::/7`) and link-local (`fe80::/10`). */
const isPrivateIpv6 = (address: string): boolean => {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") {
    return true;
  }
  const mapped = mappedIpv4Octets(normalized);
  if (mapped) {
    return isPrivateIpv4(mapped);
  }
  const prefix = normalized.slice(0, 2);
  return prefix === "fc" || prefix === "fd" || prefix === "fe";
};

const assertPublicHostname = (hostname: string): void => {
  const lower = hostname.toLowerCase();
  if (lower.length === 0) {
    reject("The URL has no host.");
  }
  if (LOOPBACK_NAMES.has(lower)) {
    reject(
      "That address is loopback - a connector must be reachable remotely."
    );
  }
  if (BLOCKED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    reject("That address is on a private network.");
  }

  const bracketed = BRACKETED_IPV6.exec(lower);
  if (bracketed?.[1] && isPrivateIpv6(bracketed[1])) {
    reject("That address is on a private network.");
  }

  const octets = IPV4.exec(lower);
  if (!octets) {
    return;
  }
  const parts = octets.slice(1).map(Number);
  if (parts.some((part) => part > IPV4_OCTET_MAX)) {
    reject("That is not a valid address.");
  }
  if (isPrivateIpv4(parts)) {
    reject("That address is on a private network.");
  }
};

/**
 * Parses and vets a URL, returning it normalized. Throws
 * `InvalidConnectorUrlError` with a message written for the human who pasted it.
 */
export const assertSafeUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    throw new InvalidConnectorUrlError("That is not a valid URL.", {
      cause: error,
    });
  }

  const loopback = isE2eLoopback(url);
  if (!loopback && url.protocol !== "https:") {
    reject("A connector URL must start with https://.");
  }
  if (url.username || url.password) {
    reject("Remove the credentials from the URL.");
  }
  if (!loopback) {
    assertPublicHostname(url.hostname);
  }
  return url;
};

export const isSafeUrl = (raw: string): boolean => {
  try {
    assertSafeUrl(raw);
    return true;
  } catch {
    return false;
  }
};

/**
 * The canonical form stored in `connectors.url` and sent to the vault as
 * `mcp_server_url`. The hash is dropped (never sent to a server) and an empty
 * query is normalized away, so two spellings of one endpoint collide on the
 * unique index instead of producing two vaults.
 */
export const canonicalizeConnectorUrl = (raw: string): string => {
  const url = assertSafeUrl(raw);
  url.hash = "";
  // A query of "?" with nothing after it parses to an empty `search` but keeps
  // the delimiter in `href`; assigning the empty string is what drops it.
  if (!url.search) {
    url.search = "";
  }
  return url.toString();
};
