import { afterEach, expect, test } from "bun:test";
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
