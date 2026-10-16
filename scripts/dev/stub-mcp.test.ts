import { afterEach, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { type StubMcp, startStubMcp } from "./stub-mcp";

const running: StubMcp[] = [];

const start = (options?: Parameters<typeof startStubMcp>[0]): StubMcp => {
  const stub = startStubMcp(options);
  running.push(stub);
  return stub;
};

afterEach(() => {
  for (const stub of running.splice(0)) {
    stub.stop();
  }
});

const post = (
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<Response> =>
  fetch(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

const listRequest = { id: 2, jsonrpc: "2.0", method: "tools/list" };

const echoRequest = (text: string) => ({
  id: 3,
  jsonrpc: "2.0",
  method: "tools/call",
  params: { arguments: { text }, name: "echo" },
});

test("initialize and tools/list list the echo tool", async () => {
  const stub = start();
  const init = await post(
    stub.url,
    { id: 1, jsonrpc: "2.0", method: "initialize", params: {} },
    bearer("stub-token")
  );
  const initBody = await init.json();
  expect(initBody.result.protocolVersion).toBe("2025-06-18");
  expect(initBody.result.serverInfo.name).toBe("stub-mcp");

  const list = await post(stub.url, listRequest, bearer("stub-token"));
  const listBody = await list.json();
  expect(
    listBody.result.tools.map((tool: { name: string }) => tool.name)
  ).toEqual(["echo"]);
});

test("tools/call echo returns the text", async () => {
  const stub = start();
  const response = await post(
    stub.url,
    echoRequest("hi there"),
    bearer("stub-token")
  );
  const body = await response.json();
  expect(body.result.content).toEqual([{ text: "hi there", type: "text" }]);
});

test("a request without the bearer is 401 with WWW-Authenticate", async () => {
  const stub = start();
  const response = await post(stub.url, listRequest);
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    'Bearer realm="stub-mcp"'
  );
  expect(await response.text()).toBe("");
});

test("a wrong token is 401", async () => {
  const stub = start();
  const response = await post(stub.url, listRequest, bearer("not-the-token"));
  expect(response.status).toBe(401);
});

test("token null needs no header", async () => {
  const stub = start({ token: null });
  const response = await post(stub.url, listRequest);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.result.tools[0].name).toBe("echo");
});

test("failOnce expires the token until POST /token issues a new one", async () => {
  const stub = start({ failOnce: true });

  const first = await post(stub.url, listRequest, bearer("stub-token"));
  expect(first.status).toBe(401);

  const old = await post(stub.url, listRequest, bearer("stub-token"));
  expect(old.status).toBe(401);

  const tokenResponse = await fetch(new URL("/token", stub.url), {
    method: "POST",
  });
  const issued = await tokenResponse.json();
  expect(issued.access_token).toBe("stub-token-refreshed-1");

  const stillOld = await post(stub.url, listRequest, bearer("stub-token"));
  expect(stillOld.status).toBe(401);

  const retried = await post(
    stub.url,
    listRequest,
    bearer(issued.access_token)
  );
  expect(retried.status).toBe(200);
  expect(stub.stats().tokenCalls).toBe(1);
});

test("sleepSeconds delays tools/call", async () => {
  const stub = start({ sleepSeconds: 0.2 });
  const started = performance.now();
  const response = await post(
    stub.url,
    echoRequest("slow"),
    bearer("stub-token")
  );
  const elapsed = performance.now() - started;
  expect(response.status).toBe(200);
  expect(elapsed).toBeGreaterThanOrEqual(150);
});

test("calls records the authorization header it received", async () => {
  const stub = start();
  await post(stub.url, listRequest, bearer("stub-token"));
  const { calls } = stub.stats();
  expect(calls).toEqual([
    {
      headers: expect.objectContaining({ authorization: "Bearer stub-token" }),
      method: "tools/list",
    },
  ]);
});

const REDIRECT_URI = "http://localhost:9999/callback";
const APPROVE_HREF = /id="approve" href="([^"]+)"/;
const CLIENT_ID = /^stub-client-\d+$/;
const ACCESS_TOKEN = /^stub-at-\d+$/;
const REFRESH_TOKEN = /^stub-rt-\d+$/;

const oauthBase = (stub: StubMcp): string => `http://127.0.0.1:${stub.port}`;

const expectedProtectedResource = (origin: string) => ({
  authorization_servers: [origin],
  resource: `${origin}/mcp`,
  scopes_supported: ["read"],
});

const expectedAuthorizationServer = (origin: string) => ({
  authorization_endpoint: `${origin}/oauth/authorize`,
  code_challenge_methods_supported: ["S256"],
  issuer: origin,
  registration_endpoint: `${origin}/oauth/register`,
  scopes_supported: ["read"],
  token_endpoint: `${origin}/oauth/token`,
  token_endpoint_auth_methods_supported: ["none"],
});

const fetchJsonAll = (urls: string[]): Promise<unknown[]> =>
  Promise.all(urls.map(async (url) => (await fetch(url)).json()));

const pkcePair = async (): Promise<{ challenge: string; verifier: string }> => {
  const verifier = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32))
  ).toString("base64url");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return { challenge: Buffer.from(digest).toString("base64url"), verifier };
};

const registerClient = async (
  stub: StubMcp,
  redirectUris: string[] = [REDIRECT_URI]
): Promise<string> => {
  const response = await post(`${oauthBase(stub)}/oauth/register`, {
    redirect_uris: redirectUris,
  });
  const body = await response.json();
  return body.client_id;
};

const authorizeRequest = (
  stub: StubMcp,
  clientId: string,
  challenge: string,
  redirectUri = REDIRECT_URI
): Promise<Response> => {
  const url = new URL("/oauth/authorize", oauthBase(stub));
  url.search = new URLSearchParams({
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    response_type: "code",
    state: "xyz",
  }).toString();
  return fetch(url);
};

/** Reads the one-time code out of the approve link on the consent page. */
const approveCode = async (page: Response): Promise<string> => {
  const html = await page.text();
  const href = APPROVE_HREF.exec(html)?.[1] ?? "";
  return new URL(href.replaceAll("&amp;", "&")).searchParams.get("code") ?? "";
};

const exchangeCode = (
  stub: StubMcp,
  form: Record<string, string>
): Promise<Response> =>
  fetch(`${oauthBase(stub)}/oauth/token`, {
    body: new URLSearchParams(form),
    method: "POST",
  });

/** Registers a client and gets a code for it, with the PKCE verifier kept. */
const grantCode = async (stub: StubMcp) => {
  const clientId = await registerClient(stub);
  const { challenge, verifier } = await pkcePair();
  const code = await approveCode(
    await authorizeRequest(stub, clientId, challenge)
  );
  return { clientId, code, verifier };
};

const issueTokens = async (stub: StubMcp) => {
  const grant = await grantCode(stub);
  const response = await exchangeCode(stub, {
    client_id: grant.clientId,
    code: grant.code,
    code_verifier: grant.verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  });
  return { body: await response.json(), status: response.status };
};

/** Calls initialize and tools/list on /mcp with an access token. */
const callMcp = async (stub: StubMcp, accessToken: string) => {
  const init = await post(
    stub.url,
    { id: 1, jsonrpc: "2.0", method: "initialize", params: {} },
    bearer(accessToken)
  );
  const initBody = await init.json();
  const list = await post(stub.url, listRequest, bearer(accessToken));
  const listBody = await list.json();
  return {
    initStatus: init.status,
    listStatus: list.status,
    serverName: initBody.result?.serverInfo.name,
    toolNames: listBody.result?.tools.map(
      (tool: { name: string }) => tool.name
    ),
  };
};

test("oauth: /mcp without an access token is 401 with the resource metadata challenge", async () => {
  const stub = start({ oauth: true });
  const response = await post(stub.url, listRequest);
  expect(response.status).toBe(401);
  expect(response.headers.get("www-authenticate")).toBe(
    `Bearer realm="stub-mcp", resource_metadata="${oauthBase(stub)}/.well-known/oauth-protected-resource"`
  );
});

test("oauth: the static token does not open /mcp", async () => {
  const stub = start({ oauth: true });
  const response = await post(stub.url, listRequest, bearer("stub-token"));
  expect(response.status).toBe(401);
});

test("oauth: both metadata documents use the stub's own host", async () => {
  const stub = start({ oauth: true });
  const origin = oauthBase(stub);
  const resources = await fetchJsonAll([
    `${origin}/.well-known/oauth-protected-resource`,
    `${origin}/.well-known/oauth-protected-resource/mcp`,
  ]);
  for (const doc of resources) {
    expect(doc).toEqual(expectedProtectedResource(origin));
  }
  const servers = await fetchJsonAll([
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/oauth-authorization-server/mcp`,
  ]);
  for (const doc of servers) {
    expect(doc).toEqual(expectedAuthorizationServer(origin));
  }
});

test("oauth: metadata and the challenge honour x-forwarded-proto and x-forwarded-host", async () => {
  const stub = start({ oauth: true });
  const forwarded = {
    "x-forwarded-host": "stub.example.test",
    "x-forwarded-proto": "https",
  };
  const origin = "https://stub.example.test";

  const resource = await fetch(
    `${oauthBase(stub)}/.well-known/oauth-protected-resource/mcp`,
    { headers: forwarded }
  );
  expect(await resource.json()).toEqual(expectedProtectedResource(origin));

  const server = await fetch(
    `${oauthBase(stub)}/.well-known/oauth-authorization-server`,
    { headers: forwarded }
  );
  expect(await server.json()).toEqual(expectedAuthorizationServer(origin));

  const challenge = await post(stub.url, listRequest, forwarded);
  expect(challenge.headers.get("www-authenticate")).toBe(
    `Bearer realm="stub-mcp", resource_metadata="${origin}/.well-known/oauth-protected-resource"`
  );
});

test("oauth: a registered client gets a consent page whose approve link carries the code", async () => {
  const stub = start({ oauth: true });
  const clientId = await registerClient(stub);
  expect(clientId).toMatch(CLIENT_ID);

  const { challenge } = await pkcePair();
  const page = await authorizeRequest(stub, clientId, challenge);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toContain("text/html");
  const html = await page.clone().text();
  expect(html).toContain("<title>Stub MCP consent</title>");
  expect(html).toContain(clientId);
  expect(html).toContain('id="deny"');

  expect(await approveCode(page)).not.toBe("");
});

test("oauth: a correct PKCE verifier exchanges the code for a token that works on /mcp", async () => {
  const stub = start({ oauth: true });
  const { status, body } = await issueTokens(stub);
  expect(status).toBe(200);
  expect(body.token_type).toBe("Bearer");
  expect(body.expires_in).toBe(3600);
  expect(body.scope).toBe("read");
  expect(body.access_token).toMatch(ACCESS_TOKEN);
  expect(body.refresh_token).toMatch(REFRESH_TOKEN);
  expect(stub.stats().tokenCalls).toBe(1);

  const mcp = await callMcp(stub, body.access_token);
  expect(mcp).toEqual({
    initStatus: 200,
    listStatus: 200,
    serverName: "stub-mcp",
    toolNames: ["echo"],
  });
});

test("oauth: a wrong PKCE verifier is invalid_grant, and the code is spent", async () => {
  const stub = start({ oauth: true });
  const grant = await grantCode(stub);
  const form = {
    client_id: grant.clientId,
    code: grant.code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  };

  const wrong = await exchangeCode(stub, {
    ...form,
    code_verifier: "not-the-verifier",
  });
  expect(wrong.status).toBe(400);
  expect(await wrong.json()).toEqual({ error: "invalid_grant" });

  const retry = await exchangeCode(stub, {
    ...form,
    code_verifier: grant.verifier,
  });
  expect(await retry.json()).toEqual({ error: "invalid_grant" });
});

test("oauth: replaying a used code is invalid_grant", async () => {
  const stub = start({ oauth: true });
  const grant = await grantCode(stub);
  const form = {
    client_id: grant.clientId,
    code: grant.code,
    code_verifier: grant.verifier,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
  };

  const first = await exchangeCode(stub, form);
  expect(first.status).toBe(200);

  const replay = await exchangeCode(stub, form);
  expect(replay.status).toBe(400);
  expect(await replay.json()).toEqual({ error: "invalid_grant" });
});

test("oauth: authorize with an unregistered redirect_uri is 400", async () => {
  const stub = start({ oauth: true });
  const clientId = await registerClient(stub);
  const { challenge } = await pkcePair();
  const response = await authorizeRequest(
    stub,
    clientId,
    challenge,
    "http://evil.example/callback"
  );
  expect(response.status).toBe(400);
});

test("oauth: the refresh_token grant issues a token that works on /mcp", async () => {
  const stub = start({ oauth: true });
  const { body: issued } = await issueTokens(stub);

  const response = await exchangeCode(stub, {
    grant_type: "refresh_token",
    refresh_token: issued.refresh_token,
  });
  expect(response.status).toBe(200);
  const refreshed = await response.json();
  expect(refreshed.access_token).toMatch(ACCESS_TOKEN);
  expect(refreshed.access_token).not.toBe(issued.access_token);
  expect(stub.stats().tokenCalls).toBe(2);

  const mcp = await callMcp(stub, refreshed.access_token);
  expect(mcp.initStatus).toBe(200);
  expect(mcp.toolNames).toEqual(["echo"]);
});
