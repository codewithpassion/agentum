/**
 * Pure helpers for the artifact view log: what a view row keeps about the
 * visitor. An IP is cut to a /24 (IPv4) or /48 (IPv6) before it is stored,
 * the visitor hash is an HMAC under a daily salt, and the referrer and user
 * agent are cut down. Pure Web Crypto, no env, no database.
 */

import { toBase64Url } from "../crypto.ts";

const HMAC = { hash: "SHA-256", name: "HMAC" } as const;
const SALT_BYTES = 16;
const USER_AGENT_LIMIT = 256;

const encoder = new TextEncoder();

const IPV4 = /^\d{1,3}$/;
const HEX_GROUP = /^[0-9a-fA-F]{1,4}$/;
const MAPPED_MARKER = 0xff_ff;

/** The four octets of a dotted IPv4 literal, or null. */
const ipv4Octets = (text: string): number[] | null => {
  const parts = text.split(".");
  if (parts.length !== 4 || !parts.every((part) => IPV4.test(part))) {
    return null;
  }
  const octets = parts.map(Number);
  return octets.every((octet) => octet <= 255) ? octets : null;
};

/**
 * The 16-bit groups of a colon-separated run. A dotted IPv4 tail is allowed
 * only when `allowDotted` is set (the very end of the address), and it counts
 * as two groups.
 */
const toGroups = (text: string, allowDotted: boolean): number[] | null => {
  if (text === "") {
    return [];
  }
  const parts = text.split(":");
  const groups: number[] = [];
  for (const [index, part] of parts.entries()) {
    const isLast = index === parts.length - 1;
    if (isLast && allowDotted && part.includes(".")) {
      const octets = ipv4Octets(part);
      if (!octets) {
        return null;
      }
      const [a = 0, b = 0, c = 0, d = 0] = octets;
      groups.push(a * 256 + b, c * 256 + d);
    } else if (HEX_GROUP.test(part)) {
      groups.push(Number.parseInt(part, 16));
    } else {
      return null;
    }
  }
  return groups;
};

/** Eight 16-bit groups of an IPv6 literal with `::` expanded, or null. */
const ipv6Groups = (ip: string): number[] | null => {
  const halves = ip.split("::");
  if (halves.length > 2) {
    return null;
  }
  const [headText = "", tailText] = halves;
  if (tailText === undefined) {
    const groups = toGroups(headText, true);
    return groups?.length === 8 ? groups : null;
  }
  const head = toGroups(headText, false);
  const tail = toGroups(tailText, true);
  if (!(head && tail) || head.length + tail.length > 7) {
    return null;
  }
  const zeros = Array.from({ length: 8 - head.length - tail.length }, () => 0);
  return [...head, ...zeros, ...tail];
};

/** The IPv4 octets inside an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`), or null. */
const mappedOctets = (groups: number[]): number[] | null => {
  const prefixIsZero = groups.slice(0, 5).every((group) => group === 0);
  if (!prefixIsZero || groups[5] !== MAPPED_MARKER) {
    return null;
  }
  const [high = 0, low = 0] = groups.slice(6);
  return [Math.floor(high / 256), high % 256, Math.floor(low / 256), low % 256];
};

/**
 * The network prefix of an IP address: IPv4 `/24`, IPv6 `/48`. Mapped IPv6
 * addresses count as IPv4. Null for anything that is not a valid literal.
 * Never throws, and the host bits never appear in the result.
 */
export const truncateIp = (ip: string): string | null => {
  const ipv4 = ipv4Octets(ip);
  if (ipv4) {
    return `${ipv4.slice(0, 3).join(".")}.0/24`;
  }
  if (!ip.includes(":")) {
    return null;
  }
  const groups = ipv6Groups(ip);
  if (!groups) {
    return null;
  }
  const mapped = mappedOctets(groups);
  if (mapped) {
    return `${mapped.slice(0, 3).join(".")}.0/24`;
  }
  return `${groups
    .slice(0, 3)
    .map((group) => group.toString(16))
    .join(":")}::/48`;
};

/**
 * HMAC-SHA-256 of `${ip}\n${userAgent}` keyed by `salt`, lower-case hex.
 * Same inputs give the same hash. A new salt, IP or user agent gives another.
 */
export const visitorHash = async (
  salt: string,
  ip: string,
  userAgent: string
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(salt),
    HMAC,
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    HMAC.name,
    key,
    encoder.encode(`${ip}\n${userAgent}`)
  );
  return [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
};

/** A new daily salt: 16 random bytes, base64url. */
export const newSalt = (): string =>
  toBase64Url(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));

/**
 * The hostname of an http or https referrer, lower case, with no port, path,
 * query or credentials. Null for anything else.
 */
export const referrerHost = (
  referrer: string | null | undefined
): string | null => {
  if (!referrer) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  return url.hostname.toLowerCase();
};

/** The user agent, trimmed and cut to 256 characters. Null when empty. */
export const cutUserAgent = (
  userAgent: string | null | undefined
): string | null => {
  const trimmed = userAgent?.trim() ?? "";
  if (trimmed === "") {
    return null;
  }
  return [...trimmed].slice(0, USER_AGENT_LIMIT).join("");
};

/** The UTC calendar day of `date` as `YYYY-MM-DD`. */
export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);
