// The SSRF guard for every URL an action fetches (trigger URLs, health
// URLs). Workers cannot resolve DNS before connecting, so a public name that
// points at a private address (or rebinds to one) is not detectable here; the
// guard covers IP literals, well-known internal names, credentials and
// redirects.

export type UrlCheck = { ok: true; url: URL } | { ok: false; reason: string };

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;
const TRAILING_DOTS = /\.+$/;
const HEX_RADIX = 16;
const BYTE = 256;
const V6_GROUPS = 8;
/** Default per-request timeout; callers with a longer budget pass their own. */
export const SAFE_FETCH_TIMEOUT_MS = 10_000;

/** [first octet, second octet low, second octet high] per blocked /8 or
 *  narrower range, plus whole /8s with null bounds. */
const BLOCKED_V4: [number, number | null, number | null][] = [
  [0, null, null], // this network
  [10, null, null], // private
  [100, 64, 127], // CGNAT 100.64.0.0/10
  [127, null, null], // loopback
  [169, 254, 254], // link-local
  [172, 16, 31], // private 172.16.0.0/12
  [192, 168, 168], // private
  [198, 18, 19], // benchmarking 198.18.0.0/15
];

function blockedV4(octets: number[]): boolean {
  const [a = 0, b = 0, c = 0] = octets;
  if (a >= 224) {
    return true; // multicast and reserved, incl. broadcast
  }
  if (a === 192 && b === 0 && c === 0) {
    return true; // IETF protocol assignments 192.0.0.0/24
  }
  return BLOCKED_V4.some(
    ([first, low, high]) =>
      a === first && (low === null || high === null || (b >= low && b <= high))
  );
}

function parseV4(host: string): number[] | null {
  const match = IPV4.exec(host);
  if (!match) {
    return null;
  }
  const octets = match.slice(1).map(Number);
  return octets.every((octet) => octet < BYTE) ? octets : null;
}

/** The IPv4 address held in two hextets. */
function v4From(high: number, low: number): number[] {
  return [
    Math.floor(high / BYTE),
    high % BYTE,
    Math.floor(low / BYTE),
    low % BYTE,
  ];
}

function parseHextets(part: string): number[] | null {
  if (part === "") {
    return [];
  }
  const groups = part.split(":");
  if (!groups.every((group) => HEXTET.test(group))) {
    return null;
  }
  return groups.map((group) => Number.parseInt(group, HEX_RADIX));
}

/** The eight 16-bit groups of an IPv6 address in the WHATWG URL parser's
 *  serialisation (lower case, `::` compression, no dotted IPv4 tail). */
function expandV6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const head = parseHextets(halves[0] ?? "");
  const tail = halves.length === 2 ? parseHextets(halves[1] ?? "") : [];
  if (head === null || tail === null) {
    return null;
  }
  const missing = V6_GROUPS - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    return null;
  }
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function blockedV6(address: string): boolean {
  const groups = expandV6(address.toLowerCase());
  if (groups === null) {
    return true; // not a form the URL parser produces: refuse
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] =
    groups;
  const firstFiveZero =
    g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (firstFiveZero && (g5 === 0 || g5 === 0xff_ff)) {
    // ::/96 (unspecified, loopback, IPv4-compatible; :: and ::1 land in
    // 0.0.0.0/8) and ::ffff:0:0/96 (IPv4-mapped): judge the IPv4 inside.
    return blockedV4(v4From(g6, g7));
  }
  if (
    g0 === 0x64 &&
    g1 === 0xff_9b &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0
  ) {
    return blockedV4(v4From(g6, g7)); // NAT64 64:ff9b::/96
  }
  if (g0 === 0x20_02) {
    return blockedV4(v4From(g1, g2)); // 6to4 2002::/16
  }
  if (g0 === 0x20_01 && g1 === 0) {
    return true; // Teredo 2001::/32 hides an IPv4 address
  }
  if (g0 === 0x64 && g1 === 0xff_9b && g2 === 1) {
    return true; // local-use NAT64 64:ff9b:1::/48
  }
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0xff_ff &&
    g5 === 0
  ) {
    return true; // IPv4-translated ::ffff:0:0:0/96
  }
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast, fec0::/10 site-local
  return (
    // biome-ignore lint/suspicious/noBitwiseOperators: Prefix masks on the first 16 bits.
    (g0 & 0xfe_00) === 0xfc_00 ||
    // biome-ignore lint/suspicious/noBitwiseOperators: Prefix masks on the first 16 bits.
    (g0 & 0xff_c0) === 0xfe_80 ||
    // biome-ignore lint/suspicious/noBitwiseOperators: Prefix masks on the first 16 bits.
    (g0 & 0xff_00) === 0xff_00 ||
    // biome-ignore lint/suspicious/noBitwiseOperators: Prefix masks on the first 16 bits.
    (g0 & 0xff_c0) === 0xfe_c0 // fec0::/10 site-local, deprecated
  );
}

function blockedHost(hostname: string): string | null {
  // "localhost." and "jobs.internal." name the same hosts as without the dot.
  const host = hostname.toLowerCase().replace(TRAILING_DOTS, "");
  if (host.startsWith("[") && host.endsWith("]")) {
    return blockedV6(host.slice(1, -1)) ? "a private IPv6 address" : null;
  }
  const octets = parseV4(host);
  if (octets) {
    return blockedV4(octets) ? "a private IPv4 address" : null;
  }
  if (
    host === "localhost" ||
    INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))
  ) {
    return "an internal host name";
  }
  if (!host.includes(".")) {
    return "a single-label host name";
  }
  return null;
}

/** Whether an action may fetch this URL. `allowHttp` exists for tests. */
export function checkUrl(
  raw: string,
  options: { allowHttp?: boolean } = {}
): UrlCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  const protocols = options.allowHttp ? ["https:", "http:"] : ["https:"];
  if (!protocols.includes(url.protocol)) {
    return { ok: false, reason: "only https URLs are allowed" };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URLs with credentials are refused" };
  }
  // The WHATWG parser already turns 127.1 or 0x7f000001 into dotted form,
  // and an embedded dotted IPv4 in IPv6 into hextets.
  const blocked = blockedHost(url.hostname);
  if (blocked) {
    return { ok: false, reason: `the host is ${blocked}` };
  }
  return { ok: true, url };
}

export type SafeFetchResult =
  | { ok: true; response: Response }
  | { ok: false; reason: string };

/** Fetches a checked URL without following redirects: a 3xx is a failure,
 *  so a redirect cannot point the request at an internal host. The request
 *  is aborted after `timeoutMs`; the rejection (a TimeoutError) propagates. */
export async function safeFetch(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  raw: string,
  init: RequestInit = {},
  options: { allowHttp?: boolean; timeoutMs?: number } = {}
): Promise<SafeFetchResult> {
  const checked = checkUrl(raw, options);
  if (!checked.ok) {
    return checked;
  }
  const response = await fetchImpl(checked.url.toString(), {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(options.timeoutMs ?? SAFE_FETCH_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, reason: `redirect (${response.status}) refused` };
  }
  return { ok: true, response };
}
