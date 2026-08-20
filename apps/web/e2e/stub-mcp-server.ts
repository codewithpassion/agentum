import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { BASE_URL } from "../playwright.config";

/**
 * The remote MCP servers the connector suite talks to, stood up inside the
 * test run.
 *
 * `node:http` rather than `Bun.serve` because Playwright specs execute in the
 * runner's Node workers - the project is Bun-first everywhere else.
 *
 * Three servers in one, told apart by path:
 *
 * - `/open/<runId>`   answers `initialize` and `tools/list` to anyone.
 * - `/secure/<runId>` 401s with an RFC 9728 challenge and then serves the same
 *   two calls to a bearer it issued, backed by the tiny authorization server
 *   below (discovery, dynamic registration, authorize, token).
 * A third server, alone on its own port, 401s with no discovery at all - that
 * is what drives the ladder down to its last rung, a pasted token. It needs a
 * separate origin because discovery falls back to treating the MCP server's own
 * origin as the issuer, and it would otherwise find the metadata above.
 *
 * The authorize endpoint deliberately ignores the `redirect_uri` it is handed
 * and sends the browser to the suite's own origin. The Worker builds that URI
 * from `PUBLIC_APP_URL`, which is pinned to port 3000 in `.env.local` and
 * cannot be overridden for one run - and nothing downstream checks it, since
 * the credential the callback validates is the one-shot `state`.
 */

export const STUB_PORT = 3141;
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`;
/** Alone on its own origin, so discovery finds nothing there at all. */
export const STUB_BEARER_PORT = 3142;
export const STUB_BEARER_ORIGIN = `http://127.0.0.1:${STUB_BEARER_PORT}`;

/** Named so the assertion that they reached the UI is unambiguous. */
export const OPEN_TOOLS = [
  { description: "Look something up in the open stub.", name: "open_lookup" },
  { description: "Write something to the open stub.", name: "open_write" },
];

/** The one tool only a credential the stub issued can see. */
export const SECURE_TOOL_NAME = "secure_read";

export const SECURE_TOOLS = [
  { description: "Read a record behind OAuth.", name: SECURE_TOOL_NAME },
];

const ISSUED_ACCESS_TOKEN = "stub-access-token";
const AUTHORIZATION_CODE = "stub-authorization-code";
const OK = 200;
const ACCEPTED = 202;
const FOUND = 302;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;

interface JsonRpcRequest {
  id?: number | string;
  method?: string;
}

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });

export interface StubHandle {
  close: () => Promise<void>;
  urls: StubUrls;
}

export interface StubUrls {
  bearerMcp: string;
  openMcp: string;
  secureMcp: string;
}

export const stubUrlsFor = (runId: string): StubUrls => ({
  bearerMcp: `${STUB_BEARER_ORIGIN}/bearer/${runId}`,
  openMcp: `${STUB_ORIGIN}/open/${runId}`,
  secureMcp: `${STUB_ORIGIN}/secure/${runId}`,
});

/**
 * Starts the stub and resolves once it is listening. Every route is keyed by
 * the caller's run id, because `connectors.url` is unique and the local D1
 * file outlives the run that wrote it.
 */
export const startStubServers = (runId: string): Promise<StubHandle> => {
  const urls = stubUrlsFor(runId);
  const resourceMetadata = `${STUB_ORIGIN}/.well-known/oauth-protected-resource/secure/${runId}`;

  const json = (
    response: ServerResponse,
    status: number,
    payload: unknown,
    headers: Record<string, string> = {}
  ): void => {
    response.writeHead(status, {
      "content-type": "application/json",
      ...headers,
    });
    response.end(JSON.stringify(payload));
  };

  const mcp = async (
    request: IncomingMessage,
    response: ServerResponse,
    tools: { description: string; name: string }[]
  ): Promise<void> => {
    const body = JSON.parse(
      (await readBody(request)) || "{}"
    ) as JsonRpcRequest;

    if (body.method === "initialize") {
      json(response, OK, {
        id: body.id,
        jsonrpc: "2.0",
        result: {
          capabilities: { tools: {} },
          protocolVersion: "2025-06-18",
          serverInfo: { name: "agentum-stub", version: "1.0.0" },
        },
      });
      return;
    }
    if (body.method === "tools/list") {
      // No `nextCursor`: the client pages up to five times when one is set.
      json(response, OK, { id: body.id, jsonrpc: "2.0", result: { tools } });
      return;
    }
    // `notifications/initialized` and anything else: accepted, no body.
    response.writeHead(ACCEPTED).end();
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", STUB_ORIGIN);
    const path = url.pathname;

    // --- the authorization server ------------------------------------------
    if (path === `/.well-known/oauth-protected-resource/secure/${runId}`) {
      json(response, OK, {
        authorization_servers: [STUB_ORIGIN],
        resource: urls.secureMcp,
        scopes_supported: ["mcp:read"],
      });
      return;
    }
    if (path === "/.well-known/oauth-authorization-server") {
      json(response, OK, {
        authorization_endpoint: `${STUB_ORIGIN}/authorize`,
        code_challenge_methods_supported: ["S256"],
        issuer: STUB_ORIGIN,
        registration_endpoint: `${STUB_ORIGIN}/register`,
        response_types_supported: ["code"],
        scopes_supported: ["mcp:read"],
        token_endpoint: `${STUB_ORIGIN}/token`,
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (path === "/register") {
      json(response, OK, {
        client_id: `stub-client-${runId}`,
        redirect_uris: [],
        token_endpoint_auth_method: "none",
      });
      return;
    }
    if (path === "/authorize") {
      // The state is echoed back untouched; the redirect target is the suite's
      // origin rather than the one we were handed. See the note at the top.
      const state = url.searchParams.get("state") ?? "";
      response
        .writeHead(FOUND, {
          location: `${BASE_URL}/api/connectors/oauth/callback?code=${AUTHORIZATION_CODE}&state=${encodeURIComponent(state)}`,
        })
        .end();
      return;
    }
    if (path === "/token") {
      json(response, OK, {
        access_token: ISSUED_ACCESS_TOKEN,
        expires_in: 3600,
        refresh_token: "stub-refresh-token",
        scope: "mcp:read",
        token_type: "Bearer",
      });
      return;
    }

    // --- the MCP endpoints --------------------------------------------------
    const authorization = request.headers.authorization ?? "";

    if (path === `/open/${runId}`) {
      mcp(request, response, OPEN_TOOLS);
      return;
    }
    if (path === `/secure/${runId}`) {
      if (authorization === `Bearer ${ISSUED_ACCESS_TOKEN}`) {
        mcp(request, response, SECURE_TOOLS);
        return;
      }
      json(
        response,
        UNAUTHORIZED,
        { error: "unauthorized" },
        {
          "www-authenticate": `Bearer resource_metadata="${resourceMetadata}"`,
        }
      );
      return;
    }
    json(response, NOT_FOUND, { error: "not found" });
  });

  const bearerOnly = createServer((request, response) => {
    const path = new URL(request.url ?? "/", STUB_BEARER_ORIGIN).pathname;
    if (path !== `/bearer/${runId}`) {
      json(response, NOT_FOUND, { error: "not found" });
      return;
    }
    // Any bearer will do: what is under test is that the dialog got here and
    // that the token it pasted is the one sent back.
    if ((request.headers.authorization ?? "").startsWith("Bearer ")) {
      mcp(request, response, SECURE_TOOLS);
      return;
    }
    json(response, UNAUTHORIZED, { error: "unauthorized" });
  });

  const listen = (target: Server, port: number): Promise<void> =>
    new Promise((resolve, reject) => {
      target.once("error", reject);
      target.listen(port, "127.0.0.1", () => resolve());
    });

  const close = async (): Promise<void> => {
    await closeServer(server);
    await closeServer(bearerOnly);
  };

  return Promise.all([
    listen(server, STUB_PORT),
    listen(bearerOnly, STUB_BEARER_PORT),
  ]).then(() => ({ close, urls }));
};

const closeServer = (target: Server): Promise<void> =>
  new Promise((resolve) => target.close(() => resolve()));
