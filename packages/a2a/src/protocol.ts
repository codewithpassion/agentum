/** The A2A version this package implements. A missing `A2A-Version` header means 0.3. */
export const A2A_PROTOCOL_VERSION = "1.0";

export const A2A_VERSION_HEADER = "A2A-Version";
export const A2A_EXTENSIONS_HEADER = "A2A-Extensions";

/** Content type of HTTP+JSON bodies. JSON-RPC bodies are `application/json`. */
export const A2A_MEDIA_TYPE = "application/a2a+json";

/** `protocolBinding` values on an agent interface. */
export const A2A_BINDINGS = ["JSONRPC", "HTTP+JSON"] as const;
export type A2aBinding = (typeof A2A_BINDINGS)[number];

/** Where a card lives under an agent's base URL. */
export const AGENT_CARD_PATH = "/.well-known/agent-card.json";
