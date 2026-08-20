import { describe, expect, test } from "bun:test";
import {
  buildAuthorizeUrl,
  challengeFor,
  chooseTokenEndpointAuth,
  discoverAuthorization,
  discoverProtectedResource,
  exchangeCode,
  generateState,
  generateVerifier,
  OAuthDiscoveryError,
  parseWwwAuthenticate,
  refreshTokens,
  registerClient,
  scopeFor,
} from "./oauth";

/**
 * The authorization server is faked as a map of URL to JSON. Everything here is
 * the ladder's paperwork: which document is asked for, in what order, and what
 * ends up on the wire at the token endpoint.
 */

const MCP_URL = "https://mcp.example.com/mcp";
const REDIRECT_URI = "https://app.example.com/api/connectors/oauth/callback";
const MANUAL_CLIENT_HINT = /client id from its documentation/;
const HTTPS_ONLY = /https/;
const CODE_ALREADY_USED = /code already used/;
const INVALID_GRANT = /invalid_grant/;
const BASE64URL_43 = /^[\w-]{43}$/;

const AS_METADATA = {
  authorization_endpoint: "https://auth.example.com/authorize",
  issuer: "https://auth.example.com",
  registration_endpoint: "https://auth.example.com/register",
  scopes_supported: ["read", "write"],
  token_endpoint: "https://auth.example.com/token",
  token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
};

interface FakeServer {
  asked: string[];
  fetchImpl: typeof fetch;
  posted: { body: string; headers: Headers; url: string }[];
}

const server = (documents: Record<string, unknown>): FakeServer => {
  const asked: string[] = [];
  const posted: { body: string; headers: Headers; url: string }[] = [];

  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "POST") {
      posted.push({
        body: String(init.body),
        headers: new Headers(init.headers),
        url,
      });
    } else {
      asked.push(url);
    }
    const document = documents[url];
    return Promise.resolve(
      document === undefined
        ? new Response("not found", { status: 404 })
        : Response.json(document)
    );
  }) as unknown as typeof fetch;

  return { asked, fetchImpl, posted };
};

const formOf = (body: string): URLSearchParams => new URLSearchParams(body);

/** Fails loudly rather than asserting against a request that never happened. */
const postedAt = (
  fake: FakeServer,
  index: number
): { body: string; headers: Headers } => {
  const call = fake.posted[index];
  if (!call) {
    throw new Error(`Expected a POST at index ${index}.`);
  }
  return call;
};

describe("parseWwwAuthenticate", () => {
  test("reads a quoted resource_metadata out of the challenge", () => {
    expect(
      parseWwwAuthenticate(
        'Bearer error="invalid_token", resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'
      )
    ).toEqual({
      error: "invalid_token",
      resource_metadata:
        "https://mcp.example.com/.well-known/oauth-protected-resource",
    });
  });

  test("is empty for an absent or unparseable header", () => {
    expect(parseWwwAuthenticate(null)).toEqual({});
    expect(parseWwwAuthenticate("Basic")).toEqual({});
  });
});

describe("discoverProtectedResource", () => {
  test("uses the URL the challenge advertises", async () => {
    const advertised = "https://mcp.example.com/custom-prm";
    const fake = server({
      [advertised]: {
        authorization_servers: ["https://auth.example.com"],
        resource: MCP_URL,
        scopes_supported: ["read"],
      },
    });

    const metadata = await discoverProtectedResource(
      MCP_URL,
      `Bearer resource_metadata="${advertised}"`,
      { fetchImpl: fake.fetchImpl }
    );

    expect(metadata?.authorizationServers).toEqual([
      "https://auth.example.com",
    ]);
    expect(fake.asked[0]).toBe(advertised);
  });

  test("falls back to the well-known path when there is no challenge", async () => {
    const fake = server({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        authorization_servers: ["https://auth.example.com"],
      },
    });

    const metadata = await discoverProtectedResource(MCP_URL, null, {
      fetchImpl: fake.fetchImpl,
    });

    expect(metadata?.authorizationServers).toEqual([
      "https://auth.example.com",
    ]);
    // The path-inserted form is tried first, per RFC 9728.
    expect(fake.asked[0]).toBe(
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp"
    );
  });

  test("falls back again to the bare well-known root", async () => {
    const fake = server({
      "https://mcp.example.com/.well-known/oauth-protected-resource": {
        authorization_servers: ["https://auth.example.com"],
      },
    });

    const metadata = await discoverProtectedResource(MCP_URL, null, {
      fetchImpl: fake.fetchImpl,
    });

    expect(metadata?.authorizationServers).toEqual([
      "https://auth.example.com",
    ]);
    expect(fake.asked).toHaveLength(2);
  });

  test("is null when the server publishes nothing", async () => {
    const fake = server({});
    expect(
      await discoverProtectedResource(MCP_URL, null, {
        fetchImpl: fake.fetchImpl,
      })
    ).toBeNull();
  });
});

describe("discoverAuthorization", () => {
  test("walks the resource document through to the authorization server", async () => {
    const fake = server({
      "https://auth.example.com/.well-known/oauth-authorization-server":
        AS_METADATA,
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        authorization_servers: ["https://auth.example.com"],
        scopes_supported: ["read"],
      },
    });

    const { metadata, resource } = await discoverAuthorization(MCP_URL, null, {
      fetchImpl: fake.fetchImpl,
    });

    expect(metadata.tokenEndpoint).toBe("https://auth.example.com/token");
    expect(metadata.registrationEndpoint).toBe(
      "https://auth.example.com/register"
    );
    expect(resource?.scopesSupported).toEqual(["read"]);
  });

  test("treats the MCP origin as the issuer when no resource document exists", async () => {
    const fake = server({
      "https://mcp.example.com/.well-known/oauth-authorization-server": {
        authorization_endpoint: "https://mcp.example.com/authorize",
        issuer: "https://mcp.example.com",
        token_endpoint: "https://mcp.example.com/token",
      },
    });

    const { metadata } = await discoverAuthorization(MCP_URL, null, {
      fetchImpl: fake.fetchImpl,
    });

    expect(metadata.tokenEndpoint).toBe("https://mcp.example.com/token");
  });

  test("accepts an OpenID configuration when the OAuth document is absent", async () => {
    const fake = server({
      "https://mcp.example.com/.well-known/openid-configuration": {
        authorization_endpoint: "https://mcp.example.com/authorize",
        issuer: "https://mcp.example.com",
        token_endpoint: "https://mcp.example.com/token",
      },
    });

    const { metadata } = await discoverAuthorization(MCP_URL, null, {
      fetchImpl: fake.fetchImpl,
    });
    expect(metadata.authorizationEndpoint).toBe(
      "https://mcp.example.com/authorize"
    );
  });

  test("explains itself when the server publishes no OAuth metadata at all", () => {
    const fake = server({});
    expect(
      discoverAuthorization(MCP_URL, null, { fetchImpl: fake.fetchImpl })
    ).rejects.toBeInstanceOf(OAuthDiscoveryError);
  });

  test("refuses to fetch metadata pointed at a private address", () => {
    const fake = server({
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        authorization_servers: ["https://169.254.169.254"],
      },
    });

    // The only issuer offered is link-local, so the ladder falls through to the
    // MCP origin - which publishes nothing - rather than fetching it.
    expect(
      discoverAuthorization(MCP_URL, null, { fetchImpl: fake.fetchImpl })
    ).rejects.toBeInstanceOf(OAuthDiscoveryError);
    expect(fake.asked.some((url) => url.includes("169.254.169.254"))).toBe(
      false
    );
  });
});

describe("registerClient", () => {
  test("registers a public client and returns its id", async () => {
    const fake = server({
      "https://auth.example.com/register": { client_id: "cid_public" },
    });

    const client = await registerClient(
      "https://auth.example.com/register",
      { clientName: "Agentum", redirectUri: REDIRECT_URI, scope: "read write" },
      { fetchImpl: fake.fetchImpl }
    );

    expect(client).toEqual({
      clientId: "cid_public",
      clientSecret: null,
      tokenEndpointAuthMethod: "none",
    });
    const body = JSON.parse(postedAt(fake, 0).body) as Record<string, unknown>;
    expect(body.redirect_uris).toEqual([REDIRECT_URI]);
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(body.scope).toBe("read write");
  });

  test("honours a secret the server issued anyway", async () => {
    const fake = server({
      "https://auth.example.com/register": {
        client_id: "cid_conf",
        client_secret: "shh",
      },
    });

    const client = await registerClient(
      "https://auth.example.com/register",
      {
        clientName: "Agentum",
        redirectUri: REDIRECT_URI,
        supportedAuthMethods: ["client_secret_post"],
      },
      { fetchImpl: fake.fetchImpl }
    );

    expect(client.clientSecret).toBe("shh");
    expect(client.tokenEndpointAuthMethod).toBe("client_secret_post");
  });

  test("points at the manual path when registration is refused", () => {
    const fake = server({});
    expect(
      registerClient(
        "https://auth.example.com/register",
        { clientName: "Agentum", redirectUri: REDIRECT_URI },
        { fetchImpl: fake.fetchImpl }
      )
    ).rejects.toThrow(MANUAL_CLIENT_HINT);
  });
});

describe("chooseTokenEndpointAuth", () => {
  test("a client with no secret is public", () => {
    expect(chooseTokenEndpointAuth(false, ["client_secret_basic"])).toBe(
      "none"
    );
  });

  test("prefers basic, then post, then basic as the RFC default", () => {
    expect(
      chooseTokenEndpointAuth(true, [
        "client_secret_post",
        "client_secret_basic",
      ])
    ).toBe("client_secret_basic");
    expect(chooseTokenEndpointAuth(true, ["client_secret_post"])).toBe(
      "client_secret_post"
    );
    expect(chooseTokenEndpointAuth(true, [])).toBe("client_secret_basic");
  });
});

describe("buildAuthorizeUrl and PKCE", () => {
  test("S256 challenge matches the RFC 7636 worked example", async () => {
    expect(
      await challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("verifier and state are unguessable and URL-safe", () => {
    const verifier = generateVerifier();
    expect(verifier).toMatch(BASE64URL_43);
    expect(generateState()).not.toBe(generateState());
  });

  test("carries PKCE, state and the RFC 8707 resource", () => {
    const url = new URL(
      buildAuthorizeUrl({
        authorizationEndpoint: "https://auth.example.com/authorize?foo=bar",
        challenge: "chal",
        clientId: "cid",
        redirectUri: REDIRECT_URI,
        resource: MCP_URL,
        scope: "read write",
        state: "st",
      })
    );

    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid",
      code_challenge: "chal",
      code_challenge_method: "S256",
      foo: "bar",
      redirect_uri: REDIRECT_URI,
      resource: MCP_URL,
      response_type: "code",
      scope: "read write",
      state: "st",
    });
  });

  test("refuses a non-https authorization endpoint", () => {
    expect(() =>
      buildAuthorizeUrl({
        authorizationEndpoint: "http://auth.example.com/authorize",
        challenge: "chal",
        clientId: "cid",
        redirectUri: REDIRECT_URI,
        resource: MCP_URL,
        state: "st",
      })
    ).toThrow(HTTPS_ONLY);
  });
});

describe("scopeFor", () => {
  const metadata = {
    authorizationEndpoint: "https://auth.example.com/authorize",
    issuer: "https://auth.example.com",
    registrationEndpoint: null,
    scopesSupported: ["as:read"],
    tokenEndpoint: "https://auth.example.com/token",
    tokenEndpointAuthMethods: [],
  };

  test("prefers what the resource document asked for", () => {
    expect(
      scopeFor(
        {
          authorizationServers: [],
          resource: null,
          scopesSupported: ["prm:read", "prm:write"],
        },
        metadata
      )
    ).toBe("prm:read prm:write");
  });

  test("falls back to the authorization server's list, then to nothing", () => {
    expect(scopeFor(null, metadata)).toBe("as:read");
    expect(scopeFor(null, { ...metadata, scopesSupported: [] })).toBeNull();
  });
});

describe("exchangeCode", () => {
  const publicClient = {
    clientId: "cid",
    clientSecret: null,
    tokenEndpointAuth: "none" as const,
  };

  test("posts the code, the verifier and the resource", async () => {
    const fake = server({
      "https://auth.example.com/token": {
        access_token: "at_1",
        expires_in: 3600,
        refresh_token: "rt_1",
        scope: "read",
      },
    });

    const tokens = await exchangeCode(
      "https://auth.example.com/token",
      publicClient,
      {
        code: "code_1",
        redirectUri: REDIRECT_URI,
        resource: MCP_URL,
        verifier: "ver_1",
      },
      { fetchImpl: fake.fetchImpl }
    );

    expect(tokens.accessToken).toBe("at_1");
    expect(tokens.refreshToken).toBe("rt_1");
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());

    const form = formOf(postedAt(fake, 0).body);
    expect(Object.fromEntries(form)).toEqual({
      client_id: "cid",
      code: "code_1",
      code_verifier: "ver_1",
      grant_type: "authorization_code",
      redirect_uri: REDIRECT_URI,
      resource: MCP_URL,
    });
  });

  test("an access-token-only grant has no refresh token", async () => {
    const fake = server({
      "https://auth.example.com/token": { access_token: "at_only" },
    });

    const tokens = await exchangeCode(
      "https://auth.example.com/token",
      publicClient,
      {
        code: "c",
        redirectUri: REDIRECT_URI,
        resource: MCP_URL,
        verifier: "v",
      },
      { fetchImpl: fake.fetchImpl }
    );

    expect(tokens.refreshToken).toBeNull();
  });

  test("sends the secret in the Basic header for client_secret_basic", async () => {
    const fake = server({
      "https://auth.example.com/token": { access_token: "at" },
    });

    await exchangeCode(
      "https://auth.example.com/token",
      {
        clientId: "cid",
        clientSecret: "sec",
        tokenEndpointAuth: "client_secret_basic",
      },
      {
        code: "c",
        redirectUri: REDIRECT_URI,
        resource: MCP_URL,
        verifier: "v",
      },
      { fetchImpl: fake.fetchImpl }
    );

    expect(postedAt(fake, 0).headers.get("authorization")).toBe(
      `Basic ${btoa("cid:sec")}`
    );
    expect(formOf(postedAt(fake, 0).body).get("client_secret")).toBeNull();
  });

  test("sends the secret in the body for client_secret_post", async () => {
    const fake = server({
      "https://auth.example.com/token": { access_token: "at" },
    });

    await exchangeCode(
      "https://auth.example.com/token",
      {
        clientId: "cid",
        clientSecret: "sec",
        tokenEndpointAuth: "client_secret_post",
      },
      {
        code: "c",
        redirectUri: REDIRECT_URI,
        resource: MCP_URL,
        verifier: "v",
      },
      { fetchImpl: fake.fetchImpl }
    );

    expect(postedAt(fake, 0).headers.get("authorization")).toBeNull();
    expect(formOf(postedAt(fake, 0).body).get("client_secret")).toBe("sec");
  });

  test("reports the server's error description", () => {
    const fetchImpl = (() =>
      Promise.resolve(
        Response.json(
          { error: "invalid_grant", error_description: "code already used" },
          { status: 400 }
        )
      )) as unknown as typeof fetch;

    expect(
      exchangeCode(
        "https://auth.example.com/token",
        publicClient,
        {
          code: "c",
          redirectUri: REDIRECT_URI,
          resource: MCP_URL,
          verifier: "v",
        },
        { fetchImpl }
      )
    ).rejects.toThrow(CODE_ALREADY_USED);
  });
});

describe("refreshTokens", () => {
  test("posts the refresh grant with the resource and scope", async () => {
    const fake = server({
      "https://auth.example.com/token": {
        access_token: "at_2",
        expires_in: 60,
        refresh_token: "rt_2",
      },
    });

    const tokens = await refreshTokens(
      "https://auth.example.com/token",
      { clientId: "cid", clientSecret: null, tokenEndpointAuth: "none" },
      { refreshToken: "rt_1", resource: MCP_URL, scope: "read" },
      { fetchImpl: fake.fetchImpl }
    );

    expect(tokens.accessToken).toBe("at_2");
    expect(Object.fromEntries(formOf(postedAt(fake, 0).body))).toEqual({
      client_id: "cid",
      grant_type: "refresh_token",
      refresh_token: "rt_1",
      resource: MCP_URL,
      scope: "read",
    });
  });

  test("fails loudly when the server has rotated the refresh token away", () => {
    const fetchImpl = (async () =>
      Response.json(
        { error: "invalid_grant" },
        { status: 400 }
      )) as unknown as typeof fetch;

    expect(
      refreshTokens(
        "https://auth.example.com/token",
        { clientId: "cid", clientSecret: null, tokenEndpointAuth: "none" },
        { refreshToken: "stale", resource: MCP_URL },
        { fetchImpl }
      )
    ).rejects.toThrow(INVALID_GRANT);
  });
});
