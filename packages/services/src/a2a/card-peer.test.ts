import { describe, expect, test } from "bun:test";
import { type AgentCard, agentCardSchema } from "@repo/a2a/agent-card";
import {
  chooseInterface,
  chooseOutboundScheme,
  schemeLabel,
} from "./card-peer.ts";

const BASE = {
  capabilities: {},
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  description: "A peer",
  name: "Peer",
  skills: [
    {
      description: "Does things",
      id: "things",
      name: "Things",
      tags: ["things"],
    },
  ],
  supportedInterfaces: [
    {
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
      url: "https://peer.example.com/a2a",
    },
  ],
  version: "1.0.0",
};

/** Parses a card the way the app reads a peer's card, so the schema runs too. */
const parseCard = (overrides: Record<string, unknown> = {}): AgentCard =>
  agentCardSchema.parse({ ...BASE, ...overrides });

const bearerScheme = { httpAuthSecurityScheme: { scheme: "bearer" } };

describe("chooseOutboundScheme", () => {
  test("no requirements and no schemes means no auth", () => {
    expect(chooseOutboundScheme(parseCard())).toEqual({
      ok: true,
      scheme: { kind: "none" },
    });
  });

  test("empty requirement lists and empty scheme maps mean no auth", () => {
    const card = parseCard({ securityRequirements: [], securitySchemes: {} });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: true,
      scheme: { kind: "none" },
    });
  });

  test("an empty requirement means no auth", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: {} }],
      securitySchemes: { bearer: bearerScheme },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: true,
      scheme: { kind: "none" },
    });
  });

  test("a bearer http scheme is bearer, case insensitive", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { bearer: {} } }],
      securitySchemes: {
        bearer: { httpAuthSecurityScheme: { scheme: "Bearer" } },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: true,
      scheme: { kind: "bearer" },
    });
  });

  test("Hermes's legacy http shape reads as bearer", () => {
    const card = parseCard({
      security: [{ bearer: [] }],
      securitySchemes: { bearer: { scheme: "bearer", type: "http" } },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: true,
      scheme: { kind: "bearer" },
    });
  });

  test("an apiKey in a header, location case insensitive, keeps the header name", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { key: {} } }],
      securitySchemes: {
        key: {
          apiKeySecurityScheme: { location: "HEADER", name: "X-Peer-Key" },
        },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: true,
      scheme: { headerName: "X-Peer-Key", kind: "api_key_header" },
    });
  });

  test("an apiKey in a query parameter is refused", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { key: {} } }],
      securitySchemes: {
        key: { apiKeySecurityScheme: { location: "query", name: "key" } },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "API key in a query parameter",
    });
  });

  test("an apiKey in a cookie is refused", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { key: {} } }],
      securitySchemes: {
        key: { apiKeySecurityScheme: { location: "cookie", name: "sid" } },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "API key in a cookie",
    });
  });

  test("an OAuth2 client credentials flow keeps its token url and scopes", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { oauth: { list: ["a:read"] } } }],
      securitySchemes: {
        oauth: {
          oauth2SecurityScheme: {
            flows: {
              clientCredentials: {
                scopes: { "a:read": "Read", "a:write": "Write" },
                tokenUrl: "https://auth.peer.example.com/token",
              },
            },
          },
        },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: true,
      scheme: {
        kind: "oauth2_client_credentials",
        scopes: ["a:read", "a:write"],
        tokenUrl: "https://auth.peer.example.com/token",
      },
    });
  });

  test("an OAuth2 authorization code flow is refused", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { oauth: {} } }],
      securitySchemes: {
        oauth: {
          oauth2SecurityScheme: {
            flows: {
              authorizationCode: {
                authorizationUrl: "https://auth.peer.example.com/authorize",
                scopes: {},
                tokenUrl: "https://auth.peer.example.com/token",
              },
            },
          },
        },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "OAuth2 authorization code",
    });
  });

  test("an OAuth2 device code flow is refused", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { oauth: {} } }],
      securitySchemes: {
        oauth: {
          oauth2SecurityScheme: {
            flows: {
              deviceCode: {
                deviceAuthorizationUrl: "https://auth.peer.example.com/device",
                scopes: {},
                tokenUrl: "https://auth.peer.example.com/token",
              },
            },
          },
        },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "OAuth2 device code",
    });
  });

  test("OpenID Connect is refused", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { oidc: {} } }],
      securitySchemes: {
        oidc: {
          openIdConnectSecurityScheme: {
            openIdConnectUrl: "https://issuer.example.com/.well-known/openid",
          },
        },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "OpenID Connect",
    });
  });

  test("mutual TLS is refused", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { mtls: {} } }],
      securitySchemes: { mtls: { mtlsSecurityScheme: {} } },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "mutual TLS",
    });
  });

  test("HTTP basic is refused by name", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { basic: {} } }],
      securitySchemes: {
        basic: { httpAuthSecurityScheme: { scheme: "basic" } },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "HTTP basic",
    });
  });

  test("another http scheme is refused as HTTP plus its name", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { digest: {} } }],
      securitySchemes: {
        digest: { httpAuthSecurityScheme: { scheme: "Digest" } },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "HTTP digest",
    });
  });

  test("an AND requirement with two schemes is refused", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { bearer: {}, key: {} } }],
      securitySchemes: {
        bearer: bearerScheme,
        key: {
          apiKeySecurityScheme: { location: "header", name: "X-Peer-Key" },
        },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "several schemes at once",
    });
  });

  test("a requirement naming an undefined scheme is refused", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { ghost: {} } }],
      securitySchemes: { bearer: bearerScheme },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "a security scheme named ghost that the card does not define",
    });
  });

  test("a requirement naming a key inherited from Object is refused", () => {
    const card = parseCard({
      securityRequirements: [{ schemes: { constructor: {} } }],
      securitySchemes: { bearer: bearerScheme },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted:
        "a security scheme named constructor that the card does not define",
    });
  });

  test("requirements are alternatives: the first usable one wins", () => {
    const card = parseCard({
      securityRequirements: [
        { schemes: { oidc: {} } },
        { schemes: { bearer: {} } },
        { schemes: { key: {} } },
      ],
      securitySchemes: {
        bearer: bearerScheme,
        key: {
          apiKeySecurityScheme: { location: "header", name: "X-Peer-Key" },
        },
        oidc: {
          openIdConnectSecurityScheme: {
            openIdConnectUrl: "https://issuer.example.com/openid",
          },
        },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: true,
      scheme: { kind: "bearer" },
    });
  });

  test("when no requirement is usable, the first refusal is reported", () => {
    const card = parseCard({
      securityRequirements: [
        { schemes: { oidc: {} } },
        { schemes: { mtls: {} } },
      ],
      securitySchemes: {
        mtls: { mtlsSecurityScheme: {} },
        oidc: {
          openIdConnectSecurityScheme: {
            openIdConnectUrl: "https://issuer.example.com/openid",
          },
        },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "OpenID Connect",
    });
  });

  test("without requirements, each declared scheme is tried in order", () => {
    const card = parseCard({
      securitySchemes: {
        apikey: {
          apiKeySecurityScheme: { location: "header", name: "X-Peer-Key" },
        },
        bearer: bearerScheme,
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: true,
      scheme: { headerName: "X-Peer-Key", kind: "api_key_header" },
    });
  });

  test("without requirements, a refused scheme is skipped for a usable one", () => {
    const card = parseCard({
      securitySchemes: {
        basic: { httpAuthSecurityScheme: { scheme: "basic" } },
        bearer: bearerScheme,
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: true,
      scheme: { kind: "bearer" },
    });
  });

  test("without requirements, when every declared scheme is refused, the first is reported", () => {
    const card = parseCard({
      securitySchemes: {
        basic: { httpAuthSecurityScheme: { scheme: "basic" } },
        mtls: { mtlsSecurityScheme: {} },
      },
    });
    expect(chooseOutboundScheme(card)).toEqual({
      ok: false,
      wanted: "HTTP basic",
    });
  });
});

describe("schemeLabel", () => {
  test("labels each kind", () => {
    expect(schemeLabel({ kind: "none" })).toBe("none");
    expect(schemeLabel({ kind: "bearer" })).toBe("bearer");
    expect(
      schemeLabel({ headerName: "X-Peer-Key", kind: "api_key_header" })
    ).toBe("api_key_header:X-Peer-Key");
    expect(
      schemeLabel({
        kind: "oauth2_client_credentials",
        scopes: [],
        tokenUrl: "https://auth.peer.example.com/token",
      })
    ).toBe("oauth2_client_credentials");
  });
});

describe("chooseInterface", () => {
  const iface = (
    protocolBinding: string,
    protocolVersion: string,
    url: string
  ) => ({ protocolBinding, protocolVersion, url });

  test("JSONRPC at 1.0 is preferred over HTTP+JSON at 1.0", () => {
    const card = parseCard({
      supportedInterfaces: [
        iface("HTTP+JSON", "1.0", "https://rest.peer.example.com/a2a"),
        iface("JSONRPC", "1.0", "https://rpc.peer.example.com:8443/a2a"),
      ],
    });
    expect(chooseInterface(card)).toEqual({
      origin: "https://rpc.peer.example.com:8443",
      url: "https://rpc.peer.example.com:8443/a2a",
    });
  });

  test("any 1.0 interface is preferred over a supported binding at another version", () => {
    const card = parseCard({
      supportedInterfaces: [
        iface("JSONRPC", "0.3", "https://old.peer.example.com/a2a"),
        iface("HTTP+JSON", "1.0", "https://rest.peer.example.com/a2a"),
      ],
    });
    expect(chooseInterface(card)?.url).toBe(
      "https://rest.peer.example.com/a2a"
    );
  });

  test("any supported binding is used when no interface is 1.0", () => {
    const card = parseCard({
      supportedInterfaces: [
        iface("GRPC", "1.0", "https://grpc.peer.example.com:50051"),
        iface("HTTP+JSON", "0.3", "https://rest.peer.example.com/a2a"),
      ],
    });
    expect(chooseInterface(card)).toEqual({
      origin: "https://rest.peer.example.com",
      url: "https://rest.peer.example.com/a2a",
    });
  });

  test("null when no interface has a supported binding", () => {
    const card = parseCard({
      supportedInterfaces: [
        iface("GRPC", "1.0", "https://grpc.peer.example.com:50051"),
      ],
    });
    expect(chooseInterface(card)).toBeNull();
  });

  test("null when the chosen url does not parse", () => {
    const card = parseCard({
      supportedInterfaces: [iface("JSONRPC", "1.0", "not a url")],
    });
    expect(chooseInterface(card)).toBeNull();
  });
});
