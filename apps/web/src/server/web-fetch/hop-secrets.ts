// Swaps the `hm-secret:NAME` placeholders in one hop for the real values, when
// the hop goes to a host each secret may reach. The caller keeps the hop with
// its placeholders and uses it for redirects, so every later hop is checked
// again against its own host. A proxy secret's placeholder is never filled: it
// is allowed only in the header its rule sets, to the rule's host, and that
// header is dropped so the proxy sets the real one. `scrubSecrets` puts the placeholders back into
// what leaves the fetcher. Nothing here logs, and no message, result or
// thrown error carries a secret value.

import {
  decidePlaceholder,
  type EnvGrant,
  fillPlaceholders,
  type ProxyGrant,
  placeholderNames,
  placeholderOf,
  proxyRefusal,
  proxySetsHeader,
} from "@repo/services/secrets/placeholders";

/** One request as it is sent: a hop of the call. */
export interface SecretHop {
  body: Uint8Array<ArrayBuffer> | undefined;
  headers: Headers;
  method: string;
  url: URL;
}

export type FilledHop =
  | {
      hop: SecretHop;
      names: string[];
      ok: true;
      /** The value of each secret this hop filled, by name. Never leaves the fetcher. */
      values: ReadonlyMap<string, string>;
    }
  | { error: "blocked" | "bad_request"; message: string; ok: false };

const GRANTS_UNREADABLE = "The platform could not read this agent's secrets";
const HTTPS_ONLY = "A secret is only sent over https";
const URL_PART_REFUSED = "A secret cannot go in that part of the URL";
const HEADER_NOT_VALID = "A header value is not valid";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

const blocked = (message: string): FilledHop => ({
  error: "blocked",
  message,
  ok: false,
});

/** The body as text, or null when it is absent or not valid UTF-8 (binary, left alone). */
const bodyTextOf = (
  body: Uint8Array<ArrayBuffer> | undefined
): string | null => {
  if (body === undefined) {
    return null;
  }
  try {
    return decoder.decode(body);
  } catch {
    return null;
  }
};

/** The URL as it is sent: a fragment never leaves the client, so it is not filled or counted. */
const withoutFragment = (url: URL): URL => {
  const sent = new URL(url.href);
  sent.hash = "";
  return sent;
};

/** The texts a secret can hide in: the URL, every header value, and the body when it is text. */
const textsOf = (hop: SecretHop, bodyText: string | null): string[] => {
  const texts = [withoutFragment(hop.url).href, ...hop.headers.values()];
  if (bodyText !== null) {
    texts.push(bodyText);
  }
  return texts;
};

/** The value of each granted name found, taking the first grant for a name as the checks do. */
const valuesFor = (
  names: readonly string[],
  grants: readonly EnvGrant[]
): Map<string, string> => {
  const values = new Map<string, string>();
  for (const grant of grants) {
    if (names.includes(grant.name) && !values.has(grant.name)) {
      values.set(grant.name, grant.value);
    }
  }
  return values;
};

/**
 * The URL with its placeholders filled, each value percent-encoded. Null when
 * the filled URL would change its scheme or host, or would carry credentials.
 */
const fillUrl = (url: URL, values: ReadonlyMap<string, string>): URL | null => {
  let filled: URL;
  try {
    filled = new URL(
      fillPlaceholders(withoutFragment(url).href, values, encodeURIComponent)
    );
  } catch {
    return null;
  }
  const moved = filled.protocol !== url.protocol || filled.host !== url.host;
  const hasCredentials = filled.username !== "" || filled.password !== "";
  return moved || hasCredentials ? null : filled;
};

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

const escapedForRegExp = (text: string): string =>
  text.replace(REGEXP_SPECIALS, "\\$&");

/**
 * `text` with each value in `values` replaced by its `hm-secret:NAME`
 * placeholder, whether it stands as the raw text or percent-encoded as in a
 * URL, in any letter case. Longest value first, one value at a time. This is
 * for what leaves the fetcher: the answer's headers and status text.
 */
export const scrubSecrets = (
  text: string,
  values: ReadonlyMap<string, string>
): string => {
  const needles: [needle: string, placeholder: string][] = [];
  for (const [name, value] of values) {
    needles.push([value, placeholderOf(name)]);
    needles.push([encodeURIComponent(value), placeholderOf(name)]);
  }
  needles.sort((a, b) => b[0].length - a[0].length);
  let scrubbed = text;
  for (const [needle, placeholder] of needles) {
    scrubbed = scrubbed.replace(
      new RegExp(escapedForRegExp(needle), "gi"),
      () => placeholder
    );
  }
  return scrubbed;
};

/**
 * A copy of the headers with each value filled and the `omit` headers left
 * out, or undefined when the result is not a valid header.
 */
const fillHeaders = (
  headers: Headers,
  values: ReadonlyMap<string, string>,
  omit: ReadonlySet<string>
): Headers | undefined => {
  const filled = new Headers();
  try {
    headers.forEach((value, name) => {
      if (!omit.has(name)) {
        filled.set(name, fillPlaceholders(value, values));
      }
    });
  } catch {
    return;
  }
  return filled;
};

/**
 * The proxy secret's placeholder is allowed only in a header its rule sets for
 * this host. Returns the refusal when it stands anywhere else, or the headers
 * (lower-case) that carry it and are to be dropped.
 */
const proxyPlacement = (
  grant: ProxyGrant,
  hop: SecretHop,
  bodyText: string | null
): { headers: string[] } | { message: string } => {
  const refused = { message: proxyRefusal(grant) };
  const elsewhere = [withoutFragment(hop.url).href, bodyText ?? ""];
  if (elsewhere.some((text) => placeholderNames(text).includes(grant.name))) {
    return refused;
  }
  const headers: string[] = [];
  for (const [name, value] of hop.headers) {
    if (placeholderNames(value).includes(grant.name)) {
      if (!proxySetsHeader(grant, name, hop.url.hostname)) {
        return refused;
      }
      headers.push(name);
    }
  }
  return { headers };
};

/**
 * The hop with its placeholders filled, as a copy. `hop` itself is never
 * changed. `loadGrants` and `loadProxies` are called only when the hop holds a
 * placeholder.
 */
export const fillHop = async (
  hop: SecretHop,
  loadGrants: () => Promise<readonly EnvGrant[]>,
  loadProxies: () => Promise<readonly ProxyGrant[]> = () => Promise.resolve([])
): Promise<FilledHop> => {
  const bodyText = bodyTextOf(hop.body);
  const names = [...new Set(textsOf(hop, bodyText).flatMap(placeholderNames))];
  if (names.length === 0) {
    return { hop, names: [], ok: true, values: new Map() };
  }

  let grants: readonly EnvGrant[];
  let proxies: readonly ProxyGrant[];
  try {
    [grants, proxies] = await Promise.all([loadGrants(), loadProxies()]);
  } catch {
    return blocked(GRANTS_UNREADABLE);
  }
  if (hop.url.protocol !== "https:") {
    return blocked(HTTPS_ONLY);
  }
  const envNames: string[] = [];
  const dropped = new Set<string>();
  for (const name of names) {
    const proxy = grants.some((grant) => grant.name === name)
      ? undefined
      : proxies.find((grant) => grant.name === name);
    if (proxy === undefined) {
      const decision = decidePlaceholder(name, hop.url.hostname, grants);
      if (!decision.ok) {
        return blocked(decision.message);
      }
      envNames.push(name);
      continue;
    }
    const placement = proxyPlacement(proxy, hop, bodyText);
    if ("message" in placement) {
      return blocked(placement.message);
    }
    for (const header of placement.headers) {
      dropped.add(header);
    }
  }

  const values = valuesFor(envNames, grants);
  const url = fillUrl(hop.url, values);
  if (url === null) {
    return blocked(URL_PART_REFUSED);
  }
  const headers = fillHeaders(hop.headers, values, dropped);
  if (headers === undefined) {
    return { error: "bad_request", message: HEADER_NOT_VALID, ok: false };
  }
  const body =
    bodyText === null
      ? hop.body
      : new Uint8Array(encoder.encode(fillPlaceholders(bodyText, values)));

  return {
    hop: { body, headers, method: hop.method, url },
    names: envNames,
    ok: true,
    values,
  };
};
