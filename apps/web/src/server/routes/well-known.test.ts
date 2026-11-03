import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createAuthServerMetadataProxy } from "../mcp/metadata.ts";
import type { AppEnv } from "./groups.ts";
import { wellKnownRoutes } from "./well-known.ts";

const CLERK_HOST = "clerk.example.com";
const ISSUER = `https://${CLERK_HOST}`;
const PUBLISHABLE_KEY = `pk_test_${btoa(`${CLERK_HOST}$`)}`;
const PROD_BASE_URL = "https://agentum.example.com";
const AS_DOCUMENT = {
  authorization_endpoint: `${ISSUER}/oauth/authorize`,
  issuer: ISSUER,
  token_endpoint: `${ISSUER}/oauth/token`,
};

const PRM_PATHS = [
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-protected-resource",
];
const AS_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-authorization-server/mcp",
];

const setup = (
  options: {
    authServerMetadata?: ReturnType<typeof createAuthServerMetadataProxy>;
    dev?: boolean;
    env?: Partial<Env>;
  } = {}
) => {
  const logs: Record<string, unknown>[] = [];
  const env = {
    CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY,
    PUBLIC_BASE_URL: PROD_BASE_URL,
    ...options.env,
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.route(
    "/.well-known",
    wellKnownRoutes({
      authServerMetadata: options.authServerMetadata,
      dev: options.dev ?? false,
      log: (entry) => logs.push(entry),
    })
  );
  const get = (url: string, init?: RequestInit) => app.request(url, init, env);
  return { app, get, logs };
};

const origin = "https://agentum.example.com";

describe("protected resource metadata", () => {
  test("names the origin's /mcp as the resource and the Clerk issuer", async () => {
    const { get } = setup();
    const response = await get(
      `${origin}/.well-known/oauth-protected-resource/mcp`
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      authorization_servers: [ISSUER],
      bearer_methods_supported: ["header"],
      resource: `${origin}/mcp`,
      resource_name: "Agentum",
      scopes_supported: ["profile", "email"],
    });
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
  });

  test("both the path-suffixed and the root URL describe /mcp", async () => {
    const { get } = setup();
    const responses = await Promise.all(
      PRM_PATHS.map((path) => get(`${origin}${path}`))
    );
    const documents = await Promise.all(
      responses.map((response) => response.json() as Promise<unknown>)
    );
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(documents[0]).toEqual(documents[1]);
  });

  test("a Host that is not PUBLIC_BASE_URL's gets PUBLIC_BASE_URL's origin outside dev", async () => {
    const { get } = setup({ dev: false });
    const response = await get(
      "https://evil.example/.well-known/oauth-protected-resource/mcp"
    );
    expect(((await response.json()) as { resource: string }).resource).toBe(
      `${PROD_BASE_URL}/mcp`
    );
  });

  test("a dev build on a local host names the request's own origin", async () => {
    const { get } = setup({ dev: true });
    const local = await get(
      "http://localhost:3100/.well-known/oauth-protected-resource/mcp"
    );
    expect(((await local.json()) as { resource: string }).resource).toBe(
      "http://localhost:3100/mcp"
    );
    const proxied = await get(
      "http://localhost:3100/.well-known/oauth-protected-resource/mcp",
      { headers: { "X-Forwarded-Proto": "https" } }
    );
    expect(((await proxied.json()) as { resource: string }).resource).toBe(
      "https://localhost:3100/mcp"
    );
  });

  test("without PUBLIC_BASE_URL it is a logged 404", async () => {
    const { get, logs } = setup({ env: { PUBLIC_BASE_URL: undefined } });
    const response = await get(
      `${origin}/.well-known/oauth-protected-resource/mcp`
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "mcp.config",
        message: "PUBLIC_BASE_URL is not set",
      })
    );
  });

  test("a publishable key that encodes no Clerk host is a logged 500", async () => {
    const { get, logs } = setup({
      env: { CLERK_PUBLISHABLE_KEY: "pk_test_bm9wZQ==" },
    });
    const response = await get(
      `${origin}/.well-known/oauth-protected-resource/mcp`
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "server_error" });
    expect(logs).toContainEqual(
      expect.objectContaining({ event: "mcp.config" })
    );
  });
});

describe("authorization server metadata", () => {
  test("serves the injected proxy's document at both paths, with CORS", async () => {
    const calls: string[] = [];
    const proxy = createAuthServerMetadataProxy({
      fetch: ((input: RequestInfo | URL) => {
        calls.push(String(input));
        return Promise.resolve(Response.json(AS_DOCUMENT));
      }) as typeof fetch,
    });
    const { get } = setup({ authServerMetadata: proxy });
    const responses = await Promise.all(
      AS_PATHS.map((path) => get(`${origin}${path}`))
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Cache-Control")).toBe("public, max-age=300");
    }
    expect(
      await Promise.all(
        responses.map((response) => response.json() as Promise<unknown>)
      )
    ).toEqual([AS_DOCUMENT, AS_DOCUMENT]);
    expect(calls[0]).toBe(`${ISSUER}/.well-known/oauth-authorization-server`);
  });

  test("a failing proxy is a logged 502", async () => {
    const proxy = createAuthServerMetadataProxy({
      fetch: (() =>
        Promise.reject(
          new TypeError("fetch failed")
        )) as unknown as typeof fetch,
    });
    const { get, logs } = setup({ authServerMetadata: proxy });
    const response = await get(`${origin}${AS_PATHS[0]}`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "bad_gateway" });
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: "mcp.metadata_failed",
        message: "fetch failed",
      })
    );
  });
});

describe("CORS", () => {
  test("every document and its OPTIONS preflight carry the CORS headers", async () => {
    const { get } = setup();
    const paths = [...PRM_PATHS, ...AS_PATHS];
    const preflights = await Promise.all(
      paths.map((path) => get(`${origin}${path}`, { method: "OPTIONS" }))
    );
    for (const response of preflights) {
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
        "GET, OPTIONS"
      );
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Accept, MCP-Protocol-Version"
      );
      expect(response.headers.get("Access-Control-Max-Age")).toBe("86400");
    }
  });
});
