/**
 * Agentum's own A2A extensions. The URIs name the extensions and need
 * not resolve. Both are advertised in `capabilities.extensions` on a card.
 */

/** Invite based pairing of two Agentum deployments. A2A has none. */
export const PAIRING_EXTENSION_URI =
  "https://harbourmaster.rockyshoreslabs.io/a2a/ext/pairing/v1";

/** A hop count in message metadata, so a chain of agents cannot loop. */
export const HOPS_EXTENSION_URI =
  "https://harbourmaster.rockyshoreslabs.io/a2a/ext/hops/v1";

/** The `metadata` key on a message that holds the number of hops so far. */
export const HOPS_METADATA_KEY = `${HOPS_EXTENSION_URI}/count`;
