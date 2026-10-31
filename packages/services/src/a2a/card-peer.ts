/**
 * Reads the agent card of a peer we call out to. Pure: no database, no fetch.
 * It picks the one outbound auth scheme v1 can send and the one interface we
 * can call, and says what it refused when nothing fits.
 */
import type { AgentCard } from "@repo/a2a/agent-card";
import type { SecurityRequirement, SecurityScheme } from "@repo/a2a/security";

export type OutboundScheme =
  | { kind: "none" }
  | { kind: "bearer" }
  | { kind: "api_key_header"; headerName: string }
  | {
      kind: "oauth2_client_credentials";
      tokenUrl: string;
      scopes: string[];
    };

export type SchemeChoice =
  | { ok: true; scheme: OutboundScheme }
  | { ok: false; wanted: string };

const NO_AUTH: SchemeChoice = { ok: true, scheme: { kind: "none" } };

const usable = (scheme: OutboundScheme): SchemeChoice => ({
  ok: true,
  scheme,
});

const refuse = (wanted: string): SchemeChoice => ({ ok: false, wanted });

const apiKeyRefusal = (location: string): string => {
  if (location === "query") {
    return "API key in a query parameter";
  }
  if (location === "cookie") {
    return "API key in a cookie";
  }
  return `API key in ${location}`;
};

/** Checks one declared scheme against what v1 can send. */
const supportScheme = (scheme: SecurityScheme): SchemeChoice => {
  const {
    apiKeySecurityScheme,
    httpAuthSecurityScheme,
    mtlsSecurityScheme,
    oauth2SecurityScheme,
    openIdConnectSecurityScheme,
  } = scheme;

  if (httpAuthSecurityScheme) {
    const httpScheme = httpAuthSecurityScheme.scheme.toLowerCase();
    return httpScheme === "bearer"
      ? usable({ kind: "bearer" })
      : refuse(`HTTP ${httpScheme}`);
  }

  if (apiKeySecurityScheme) {
    const location = apiKeySecurityScheme.location.toLowerCase();
    return location === "header"
      ? usable({
          headerName: apiKeySecurityScheme.name,
          kind: "api_key_header",
        })
      : refuse(apiKeyRefusal(location));
  }

  if (oauth2SecurityScheme) {
    const { flows } = oauth2SecurityScheme;
    if (flows.clientCredentials) {
      return usable({
        kind: "oauth2_client_credentials",
        scopes: Object.keys(flows.clientCredentials.scopes),
        tokenUrl: flows.clientCredentials.tokenUrl,
      });
    }
    if (flows.authorizationCode) {
      return refuse("OAuth2 authorization code");
    }
    if (flows.deviceCode) {
      return refuse("OAuth2 device code");
    }
    return refuse("OAuth2 implicit or password flow");
  }

  if (openIdConnectSecurityScheme) {
    return refuse("OpenID Connect");
  }

  if (mtlsSecurityScheme) {
    return refuse("mutual TLS");
  }

  return refuse("a security scheme of a type this version does not know");
};

/**
 * One requirement is one alternative. It is usable when it names no scheme
 * (no auth) or exactly one scheme that the card defines and v1 supports.
 */
const requirementChoice = (
  card: AgentCard,
  requirement: SecurityRequirement
): SchemeChoice => {
  const [name, ...others] = Object.keys(requirement.schemes);
  if (name === undefined) {
    return NO_AUTH;
  }
  if (others.length > 0) {
    return refuse("several schemes at once");
  }

  const schemes = card.securitySchemes ?? {};
  // Own keys only, so a name such as "constructor" is not read off Object.
  const scheme = Object.hasOwn(schemes, name) ? schemes[name] : undefined;
  if (scheme === undefined) {
    return refuse(
      `a security scheme named ${name} that the card does not define`
    );
  }
  return supportScheme(scheme);
};

/** The first usable choice, or else the first refusal. */
const firstUsable = (choices: SchemeChoice[]): SchemeChoice => {
  const found = choices.find((choice) => choice.ok);
  const [first] = choices;
  return found ?? first ?? refuse("a security scheme");
};

/**
 * Picks the outbound auth scheme for a peer. With `securityRequirements`, each
 * requirement is an alternative. Without them, each declared scheme is one, in
 * declaration order. A card with no schemes at all needs no auth.
 */
export const chooseOutboundScheme = (card: AgentCard): SchemeChoice => {
  const requirements = card.securityRequirements ?? [];
  if (requirements.length > 0) {
    return firstUsable(
      requirements.map((requirement) => requirementChoice(card, requirement))
    );
  }

  const declared = Object.values(card.securitySchemes ?? {});
  if (declared.length === 0) {
    return NO_AUTH;
  }
  return firstUsable(declared.map((scheme) => supportScheme(scheme)));
};

/** A short, stable label for logs and stored choices. */
export const schemeLabel = (scheme: OutboundScheme): string =>
  scheme.kind === "api_key_header"
    ? `api_key_header:${scheme.headerName}`
    : scheme.kind;

const CALLABLE_BINDINGS = ["JSONRPC", "HTTP+JSON"];

/**
 * The interface to call. JSONRPC at 1.0 wins, then any 1.0 interface, then any
 * binding v1 can call. Null when none fits or the chosen url does not parse.
 */
export const chooseInterface = (
  card: AgentCard
): { origin: string; url: string } | null => {
  const callable = card.supportedInterfaces.filter((entry) =>
    CALLABLE_BINDINGS.includes(entry.protocolBinding)
  );
  const chosen =
    callable.find(
      (entry) =>
        entry.protocolBinding === "JSONRPC" && entry.protocolVersion === "1.0"
    ) ??
    callable.find((entry) => entry.protocolVersion === "1.0") ??
    callable[0];
  if (chosen === undefined) {
    return null;
  }

  try {
    return { origin: new URL(chosen.url).origin, url: chosen.url };
  } catch {
    return null;
  }
};
