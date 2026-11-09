/**
 * Placeholders for env secrets. An isolate agent sees `hm-secret:NAME` where
 * the value would be. The fetcher swaps the placeholder for the value, and
 * only for a host the secret may be sent to.
 */
import { matchHost, normalizeHost } from "./rules.ts";

export const PLACEHOLDER_PREFIX = "hm-secret:";

const PLACEHOLDER = /hm-secret:([A-Za-z_][A-Za-z0-9_]*)/g;
const NAME_MAX = 64;
/** The name is not repeated: it may be text a server sent, and only a granted name is safe to show. */
const NOT_GRANTED =
  "A placeholder in the request is not for a secret granted to this agent";

/** The placeholder an agent sees for the secret `name`. */
export const placeholderOf = (name: string): string =>
  `${PLACEHOLDER_PREFIX}${name}`;

/** The distinct secret names placed in `text`, in order of first appearance. */
export const placeholderNames = (text: string): string[] => {
  const names = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return [...names];
};

/** A granted env secret: its name, its plaintext value and the hosts it may reach. */
export interface EnvGrant {
  hosts: readonly string[];
  name: string;
  value: string;
}

/**
 * `text` with each placeholder whose name is in `values` replaced by its
 * value, passed through `encode` when given. One pass, so a value is never
 * read as a placeholder or expanded again, and `$&` in a value stays literal.
 * A placeholder with no value is left as it is.
 */
export const fillPlaceholders = (
  text: string,
  values: ReadonlyMap<string, string>,
  encode?: (value: string) => string
): string =>
  text.replace(PLACEHOLDER, (placeholder: string, name: string) => {
    const value = values.get(name);
    if (value === undefined) {
      return placeholder;
    }
    return encode ? encode(value) : value;
  });

export type PlaceholderDecision = { ok: true } | { message: string; ok: false };

/** Whether the secret `name` may be sent to `host`, and why not if it may not. */
export const decidePlaceholder = (
  name: string,
  host: string,
  grants: readonly Pick<EnvGrant, "hosts" | "name">[]
): PlaceholderDecision => {
  const label = name.slice(0, NAME_MAX);
  const grant = grants.find((candidate) => candidate.name === name);
  if (grant === undefined) {
    return { message: NOT_GRANTED, ok: false };
  }
  if (grant.hosts.length === 0) {
    return {
      message: `${label} has no allowed hosts. Add them in Settings, Secrets.`,
      ok: false,
    };
  }
  const target = normalizeHost(host);
  if (!grant.hosts.some((pattern) => matchHost(pattern, target))) {
    return {
      message: `${label} may only be sent to ${grant.hosts.join(", ")}`,
      ok: false,
    };
  }
  return { ok: true };
};

/** A granted proxy secret: its name and the host and header of each rule. Never its value. */
export interface ProxyGrant {
  name: string;
  rules: readonly { header: string; host: string }[];
}

const unique = (items: readonly string[]): string[] => [...new Set(items)];

/** Why a proxy secret's placeholder is not accepted where it stands, in words an agent can act on. */
export const proxyRefusal = (grant: ProxyGrant): string => {
  const headers = unique(grant.rules.map((rule) => rule.header));
  const hosts = unique(grant.rules.map((rule) => rule.host));
  return `${grant.name.slice(0, NAME_MAX)} is a proxy secret. The platform sets the ${headers.join(", ")} ${headers.length === 1 ? "header" : "headers"} on ${hosts.join(", ")} itself, so send the request without it.`;
};

/** Whether the proxy secret's rules set `header` (any letter case) for a request to `host`. */
export const proxySetsHeader = (
  grant: ProxyGrant,
  header: string,
  host: string
): boolean =>
  grant.rules.some(
    (rule) =>
      rule.header.toLowerCase() === header.toLowerCase() &&
      matchHost(rule.host, normalizeHost(host))
  );
