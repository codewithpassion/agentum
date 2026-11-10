/// <reference types="bun" />
import { expect, test } from "bun:test";
import { cimdClientName } from "./cimd-client-name.ts";

const CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";

interface Call {
  init: RequestInit | undefined;
  url: string;
}

const fakeFetch = (respond: () => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const fn = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ init, url: String(input) });
    return Promise.resolve(respond());
  }) as typeof fetch;
  return { calls, fn };
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });

const lookup = (
  respond: () => Response | Promise<Response>,
  clientId = CLIENT_ID
) => {
  const { fn, calls } = fakeFetch(respond);
  return cimdClientName(fn)(clientId).then((name) => ({ calls, name }));
};

test("returns the client_name of a valid document", async () => {
  const { name, calls } = await lookup(() =>
    jsonResponse({ client_id: CLIENT_ID, client_name: "Claude" })
  );
  expect(name).toBe("Claude");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(CLIENT_ID);
  expect(calls[0]?.init?.redirect).toBe("manual");
  expect(calls[0]?.init?.signal).toBeDefined();
  expect(new Headers(calls[0]?.init?.headers).get("accept")).toBe(
    "application/json"
  );
});

test("trims surrounding whitespace from the name", async () => {
  const { name } = await lookup(() =>
    jsonResponse({ client_id: CLIENT_ID, client_name: "  Claude Desktop \n" })
  );
  expect(name).toBe("Claude Desktop");
});

test("caps the name at 100 code points", async () => {
  const long = "😀".repeat(150);
  const { name } = await lookup(() =>
    jsonResponse({ client_id: CLIENT_ID, client_name: long })
  );
  expect(name).toBe("😀".repeat(100));
});

test("gives null when client_id does not equal the client id", async () => {
  const { name } = await lookup(() =>
    jsonResponse({
      client_id: `${CLIENT_ID}/other`,
      client_name: "Claude",
    })
  );
  expect(name).toBeNull();
});

test("gives null for a non-JSON content type", async () => {
  const { name } = await lookup(
    () =>
      new Response(
        JSON.stringify({ client_id: CLIENT_ID, client_name: "Claude" }),
        { headers: { "content-type": "text/html" } }
      )
  );
  expect(name).toBeNull();
});

test("gives null when content-length is over the cap", async () => {
  const { name } = await lookup(
    () =>
      new Response(JSON.stringify({ client_id: CLIENT_ID, client_name: "C" }), {
        headers: {
          "content-length": "65537",
          "content-type": "application/json",
        },
      })
  );
  expect(name).toBeNull();
});

test("gives null when a streamed body with no content-length is over the cap", async () => {
  const padding = "x".repeat(65_536);
  const body = JSON.stringify({
    client_id: CLIENT_ID,
    client_name: "Claude",
    padding,
  });
  const { name } = await lookup(
    () =>
      new Response(body, { headers: { "content-type": "application/json" } })
  );
  expect(body.length).toBeGreaterThan(65_536);
  expect(name).toBeNull();
});

test("never fetches a non-https client id", async () => {
  const { name, calls } = await lookup(
    () =>
      jsonResponse({ client_id: "http://claude.ai/oauth/x", client_name: "C" }),
    "http://claude.ai/oauth/x"
  );
  expect(name).toBeNull();
  expect(calls).toHaveLength(0);
});

test("never fetches an https client id with no path", async () => {
  const results = await Promise.all(
    ["https://claude.ai", "https://claude.ai/"].map((clientId) =>
      lookup(
        () => jsonResponse({ client_id: clientId, client_name: "C" }),
        clientId
      )
    )
  );
  for (const { name, calls } of results) {
    expect(name).toBeNull();
    expect(calls).toHaveLength(0);
  }
});

test("gives null when the fetch rejects", async () => {
  const { name } = await lookup(() =>
    Promise.reject(new TypeError("network down"))
  );
  expect(name).toBeNull();
});

test("gives null for a non-OK status", async () => {
  const { name } = await lookup(() =>
    jsonResponse({ client_id: CLIENT_ID, client_name: "Claude" }, 404)
  );
  expect(name).toBeNull();
});

test("gives null when client_name is missing", async () => {
  const { name } = await lookup(() => jsonResponse({ client_id: CLIENT_ID }));
  expect(name).toBeNull();
});

test("gives null when client_name is not a string", async () => {
  const { name } = await lookup(() =>
    jsonResponse({ client_id: CLIENT_ID, client_name: 42 })
  );
  expect(name).toBeNull();
});

test("gives null for a body that is not JSON", async () => {
  const { name } = await lookup(
    () =>
      new Response("not json", {
        headers: { "content-type": "application/json" },
      })
  );
  expect(name).toBeNull();
});

test("gives null for a name that is only whitespace", async () => {
  const { name } = await lookup(() =>
    jsonResponse({ client_id: CLIENT_ID, client_name: "   " })
  );
  expect(name).toBeNull();
});

test("does not fetch a private, loopback or internal address", async () => {
  for (const clientId of [
    "https://127.0.0.1/client.json",
    "https://localhost/client.json",
    "https://10.0.0.5/client.json",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/client.json",
    "https://user:pass@example.com/client.json",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: each case is a separate lookup
    const { name, calls } = await lookup(
      () => jsonResponse({ client_id: clientId, client_name: "Evil" }),
      clientId
    );
    expect(name).toBeNull();
    expect(calls).toHaveLength(0);
  }
});
