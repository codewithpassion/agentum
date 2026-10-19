// Swaps the `hm-secret:NAME` placeholders in one hop for the real values, when
// the hop goes to a host each secret may reach. The caller keeps the hop with
// its placeholders and uses it for redirects, so every later hop is checked
// again against its own host. Nothing here logs, and no message, result or
// thrown error carries a secret value.

import {
  decidePlaceholder,
  type EnvGrant,
  fillPlaceholders,
  placeholderNames,
  placeholderOf,
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
      /**
       * Turns the values this hop filled in back into placeholders, in a text
       * the server sent back (a `Location`). A server may echo what it was
       * sent, and the next hop must be built from the placeholder form so it
       * is checked again against its own host.
       */
      restore: (text: string) => string;
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

const keep = (text: string): string => text;

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

/**
 * A function that puts the placeholder back wherever one of the values stands,
 * as the raw text or percent-encoded as in a URL. Longest value first.
 */
const restorerOf = (
  values: ReadonlyMap<string, string>
): ((text: string) => string) => {
  const needles = new Map<string, string>();
  for (const [name, value] of values) {
    needles.set(value, placeholderOf(name));
    needles.set(encodeURIComponent(value), placeholderOf(name));
  }
  const ordered = [...needles.keys()].sort((a, b) => b.length - a.length);
  if (ordered.length === 0) {
    return keep;
  }
  const pattern = new RegExp(
    ordered.map((needle) => needle.replace(REGEXP_SPECIALS, "\\$&")).join("|"),
    "g"
  );
  return (text) =>
    text.replace(pattern, (found) => needles.get(found) ?? found);
};

/** A copy of the headers with each value filled, or undefined when the result is not a valid header. */
const fillHeaders = (
  headers: Headers,
  values: ReadonlyMap<string, string>
): Headers | undefined => {
  const filled = new Headers();
  try {
    headers.forEach((value, name) => {
      filled.set(name, fillPlaceholders(value, values));
    });
  } catch {
    return;
  }
  return filled;
};

/**
 * The hop with its placeholders filled, as a copy. `hop` itself is never
 * changed. `loadGrants` is called only when the hop holds a placeholder.
 */
export const fillHop = async (
  hop: SecretHop,
  loadGrants: () => Promise<readonly EnvGrant[]>
): Promise<FilledHop> => {
  const bodyText = bodyTextOf(hop.body);
  const names = [...new Set(textsOf(hop, bodyText).flatMap(placeholderNames))];
  if (names.length === 0) {
    return { hop, names: [], ok: true, restore: keep };
  }

  let grants: readonly EnvGrant[];
  try {
    grants = await loadGrants();
  } catch {
    return blocked(GRANTS_UNREADABLE);
  }
  if (hop.url.protocol !== "https:") {
    return blocked(HTTPS_ONLY);
  }
  for (const name of names) {
    const decision = decidePlaceholder(name, hop.url.hostname, grants);
    if (!decision.ok) {
      return blocked(decision.message);
    }
  }

  const values = valuesFor(names, grants);
  const url = fillUrl(hop.url, values);
  if (url === null) {
    return blocked(URL_PART_REFUSED);
  }
  const headers = fillHeaders(hop.headers, values);
  if (headers === undefined) {
    return { error: "bad_request", message: HEADER_NOT_VALID, ok: false };
  }
  const body =
    bodyText === null
      ? hop.body
      : new Uint8Array(encoder.encode(fillPlaceholders(bodyText, values)));

  return {
    hop: { body, headers, method: hop.method, url },
    names,
    ok: true,
    restore: restorerOf(values),
  };
};
