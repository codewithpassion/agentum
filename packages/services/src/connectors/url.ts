/**
 * Connector URL validation. The SSRF guard itself lives in ./safe-url.ts, the
 * one check every action that fetches a URL shares. Connector URLs come from
 * the human, but so do the endpoints *discovered* from them - a hostile MCP
 * server can point its protected-resource metadata at anything - so discovery
 * results are validated on exactly the same terms as the URL that was pasted.
 *
 * Limitation, accepted: a Worker cannot resolve DNS, so the guard blocks
 * literal private addresses and internal names, not a public hostname with an
 * `A` record pointing at 127.0.0.1. The proxy (`/api/proxy/:connectorId`)
 * forwards tool calls from the Worker to these URLs, so this limit applies to
 * them too. The proxy runs the guard again on every call, and never follows a
 * redirect.
 */

import { checkUrl } from "./safe-url.ts";

export class InvalidConnectorUrlError extends Error {}

/**
 * Parses and vets a URL, returning it normalized. Throws
 * `InvalidConnectorUrlError` with a message written for the human who pasted it.
 */
export const assertSafeUrl = (raw: string): URL => {
  const checked = checkUrl(raw);
  if (!checked.ok) {
    throw new InvalidConnectorUrlError(
      `That URL is not allowed: ${checked.reason}.`
    );
  }
  return checked.url;
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
 * The canonical form stored in `connectors.url`. The hash is dropped (never
 * sent to a server), an empty query is normalized away, and the host is
 * lower-cased by `URL`, so two spellings of one endpoint come out identical.
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
