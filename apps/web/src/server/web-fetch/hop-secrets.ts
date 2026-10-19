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

/** The `Location` of a redirect, ready for the next hop, or why it cannot be followed. */
export type Restored =
  | { location: string; ok: true }
  | { message: string; ok: false };

export type FilledHop =
  | {
      hop: SecretHop;
      names: string[];
      ok: true;
      /**
       * Prepares the `Location` a server answered with, after this hop filled
       * a secret. A server may echo what it was sent. The values it echoes go
       * back to placeholders, so the next hop is built from the placeholder
       * form and checked again against its own host. The redirect is refused
       * when its host is not allowed for every secret this hop filled, or
       * when a value is still in it in a form that cannot be put back.
       */
      restore: (location: string) => Restored;
    }
  | { error: "blocked" | "bad_request"; message: string; ok: false };

const GRANTS_UNREADABLE = "The platform could not read this agent's secrets";
const HTTPS_ONLY = "A secret is only sent over https";
const URL_PART_REFUSED = "A secret cannot go in that part of the URL";
const HEADER_NOT_VALID = "A header value is not valid";
const ECHOED_SECRET =
  "The redirect carries a secret in a form that cannot be taken out";

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

const keep = (location: string): Restored => ({ location, ok: true });

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
const STRIPPED_BY_URL_PARSER = /[\t\n\r]/g;
const PERCENT_ESCAPE = /%([0-9a-f]{2})/gi;
const HEX = 16;
const CANON_ROUNDS = 4;

const percentDecoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text.replace(PERCENT_ESCAPE, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, HEX))
    );
  }
};

/**
 * A text with the spelling differences a server or the URL parser may add
 * taken out: tabs and line breaks, percent-encoding (repeatedly), `+` for a
 * space, and letter case. Two spellings of one value come out equal.
 */
const canonical = (text: string): string => {
  let current = text;
  for (let round = 0; round < CANON_ROUNDS; round += 1) {
    const next = percentDecoded(current.replace(STRIPPED_BY_URL_PARSER, ""))
      .replaceAll("+", " ")
      .toLowerCase();
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
};

/**
 * Handles the `Location` of a redirect after a hop that filled `values`.
 * Where a value stands as the raw text or percent-encoded as in a URL, and
 * nothing word-like follows it, the placeholder goes back in. The redirect is
 * refused when its host is not allowed for every secret filled, and when any
 * value is still in it in another spelling.
 */
const restorerOf =
  (
    values: ReadonlyMap<string, string>,
    grants: readonly EnvGrant[],
    base: URL
  ): ((location: string) => Restored) =>
  (location) => {
    const needles = new Map<string, string>();
    for (const [name, value] of values) {
      needles.set(value, placeholderOf(name));
      needles.set(encodeURIComponent(value), placeholderOf(name));
    }
    const ordered = [...needles.keys()].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(
      `(?:${ordered.map((needle) => needle.replace(REGEXP_SPECIALS, "\\$&")).join("|")})(?![A-Za-z0-9_])`,
      "g"
    );
    const restored = location.replace(
      pattern,
      (found) => needles.get(found) ?? found
    );
    const folded = canonical(restored);
    for (const value of values.values()) {
      if (folded.includes(canonical(value))) {
        return { message: ECHOED_SECRET, ok: false };
      }
    }
    let target: URL | undefined;
    try {
      target = new URL(restored, base);
    } catch {
      // Not a URL: the redirect guard refuses it with its own reason.
    }
    if (target !== undefined) {
      for (const name of values.keys()) {
        const decision = decidePlaceholder(name, target.hostname, grants);
        if (!decision.ok) {
          return { message: decision.message, ok: false };
        }
      }
    }
    return { location: restored, ok: true };
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
    restore: restorerOf(values, grants, hop.url),
  };
};
