const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const parse = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

/**
 * The reason a Cloud run cannot start in dev, or undefined. `PUBLIC_BASE_URL`
 * names a localhost address on a different origin than the request, so the MCP
 * server fixed into the run would point at a port nothing answers on.
 */
export const platformUrlMismatch = (
  platformUrl: string,
  requestOrigin: string | undefined
): string | undefined => {
  if (requestOrigin === undefined) {
    return;
  }
  const configured = parse(platformUrl);
  const actual = parse(requestOrigin);
  if (
    !(
      configured &&
      actual &&
      LOCAL_HOSTS.has(configured.hostname) &&
      LOCAL_HOSTS.has(actual.hostname)
    ) ||
    configured.origin === actual.origin
  ) {
    return;
  }
  return `PUBLIC_BASE_URL is ${configured.origin}, but this app runs on ${actual.origin}. A Cloud run reaches the platform at PUBLIC_BASE_URL, so it cannot start on this port. Start the dev server on the port in PUBLIC_BASE_URL, or set PUBLIC_BASE_URL to ${actual.origin} in apps/web/.env.local.`;
};
