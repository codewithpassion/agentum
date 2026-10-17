/** Where the explicit relay lives and how an agent reaches it. */

/** The environment variable that holds the relay token, where the agent can use it. */
export const RELAY_TOKEN_ENV = "HARBOURMASTER_RELAY_TOKEN";

/** The route prefix: `/api/egress/<host>/<path>`. */
export const RELAY_PATH = "/api/egress";

const TRAILING_SLASHES = /\/+$/;

/** The relay address for `host` (a host or the word `<host>`) and an optional path. */
export const relayUrl = (base: string, host: string, path = ""): string =>
  `${base.replace(TRAILING_SLASHES, "")}${RELAY_PATH}/${host}${path}`;
