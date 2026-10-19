import {
  assertSafeUrl,
  InvalidConnectorUrlError,
} from "@repo/services/connectors/url";

export type TargetCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

const TRAILING_DOTS = /\.+$/;
const HTTP_SCHEME = /^http:/;

/** The hostname as a URL compares it: lower case, no trailing dots, no port. */
function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(TRAILING_DOTS, "");
}

/** The Worker's own host names, so a fetch cannot loop back into the app. */
export function ownHostsOf(
  publicBaseUrl: string | undefined,
  extra: readonly string[] = []
): string[] {
  const hosts = new Set<string>();
  if (publicBaseUrl) {
    try {
      hosts.add(normalizeHost(new URL(publicBaseUrl).hostname));
    } catch {
      // A malformed base URL adds no host. The guard still refuses the
      // private and internal names it does know about.
    }
  }
  for (const name of extra) {
    try {
      hosts.add(normalizeHost(new URL(`https://${name}`).hostname));
    } catch {
      // Skip a name that is not a host, the same as a malformed base URL.
    }
  }
  return [...hosts];
}

/** Whether an agent may fetch this URL. Redirect targets go through here too. */
export function checkTarget(
  raw: string,
  ownHosts: readonly string[]
): TargetCheck {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "only http and https URLs are allowed" };
  }
  // assertSafeUrl takes https only. The host, credential and name checks do
  // not depend on the scheme, so an http URL is checked in its https form.
  try {
    assertSafeUrl(url.href.replace(HTTP_SCHEME, "https:"));
  } catch (error) {
    if (error instanceof InvalidConnectorUrlError) {
      return { ok: false, reason: error.message };
    }
    throw error;
  }
  if (ownHosts.includes(normalizeHost(url.hostname))) {
    return { ok: false, reason: "the host is this Worker" };
  }
  return { ok: true, url };
}

/** Checks a redirect's Location, resolved against the URL that sent it. */
export function redirectTarget(
  from: URL,
  location: string | null,
  ownHosts: readonly string[]
): TargetCheck {
  if (!location || location.trim() === "") {
    return { ok: false, reason: "the redirect has no Location" };
  }
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return { ok: false, reason: "the redirect Location is not a valid URL" };
  }
  return checkTarget(target.href, ownHosts);
}
