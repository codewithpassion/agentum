/// <reference types="bun" />
import { expect, test } from "bun:test";
import {
  AUTH_SERVER_METADATA_TTL_MS,
  createAuthServerMetadataProxy,
  issuerFromPublishableKey,
  MAX_AUTH_SERVER_METADATA_BYTES,
  mcpOrigin,
  resolveIssuer,
} from "./metadata.ts";

const PROD = "https://agentum.example.com";

// A made-up instance host, encoded the way Clerk encodes it.
const HOST = "example-instance-12.clerk.accounts.dev";
const PK = `pk_test_${btoa(`${HOST}$`)}`;

test("the issuer is the host encoded in the publishable key", () => {
  expect(issuerFromPublishableKey(PK)).toBe(`https://${HOST}`);
  expect(
    issuerFromPublishableKey(`pk_live_${btoa("clerk.example.com$")}`)
  ).toBe("https://clerk.example.com");
  expect(issuerFromPublishableKey(undefined)).toBeNull();
  expect(issuerFromPublishableKey("sk_test_abc")).toBeNull();
  // No trailing `$`, or a value that is no host.
  expect(issuerFromPublishableKey(`pk_test_${btoa(HOST)}`)).toBeNull();
  expect(issuerFromPublishableKey(`pk_test_${btoa("a/b@c$")}`)).toBeNull();
});

test("resolveIssuer derives the issuer from the publishable key only", () => {
  expect(resolveIssuer(PK)).toEqual({ issuer: `https://${HOST}`, ok: true });
  for (const bad of [undefined, "", "sk_test_abc", `pk_test_${btoa(HOST)}`]) {
    expect(resolveIssuer(bad)).toEqual({
      message: "CLERK_PUBLISHABLE_KEY does not encode a Clerk host",
      ok: false,
    });
  }
});

test("production names PUBLIC_BASE_URL and never reflects the Host", () => {
  const prod = { dev: false, publicBaseUrl: PROD };
  expect(mcpOrigin(`${PROD}/mcp`, prod)).toBe(PROD);
  // Behind a proxy the Worker may see http; PUBLIC_BASE_URL keeps https.
  expect(mcpOrigin("http://agentum.example.com/mcp", prod)).toBe(PROD);
  expect(mcpOrigin("https://evil.example/mcp", prod)).toBe(PROD);
  expect(mcpOrigin("http://localhost:3100/mcp", prod)).toBe(PROD);
  expect(
    mcpOrigin("https://evil.example/mcp", { ...prod, forwardedProto: "http" })
  ).toBe(PROD);
  // Nothing configured: no origin at all rather than a guessed one.
  expect(
    mcpOrigin("https://evil.example/mcp", {
      dev: false,
      publicBaseUrl: undefined,
    })
  ).toBeNull();
});

test("a dev build follows the request's origin on the local dev hosts only", () => {
  const dev = { dev: true, publicBaseUrl: PROD };
  expect(mcpOrigin("http://localhost:3100/mcp", dev)).toBe(
    "http://localhost:3100"
  );
  expect(mcpOrigin("http://127.0.0.1:3100/mcp", dev)).toBe(
    "http://127.0.0.1:3100"
  );
  expect(mcpOrigin("http://[::1]:3100/mcp", dev)).toBe("http://[::1]:3100");
  expect(
    mcpOrigin("http://localhost:3100/mcp", {
      ...dev,
      forwardedProto: "https",
    })
  ).toBe("https://localhost:3100");
  expect(mcpOrigin("https://evil.example/mcp", dev)).toBe(PROD);
  // PUBLIC_BASE_URL's own host wins over the dev rule.
  expect(mcpOrigin(`${PROD}/mcp`, { dev: true, publicBaseUrl: PROD })).toBe(
    PROD
  );
});

const upstream = (issuer: string) => {
  const calls: string[] = [];
  let status = 200;
  let fail = false;
  const fetchFn = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    if (fail) {
      return Promise.reject(new TypeError("fetch failed"));
    }
    return Promise.resolve(
      Response.json(
        { issuer, token_endpoint: `${issuer}/oauth/token` },
        { status }
      )
    );
  }) as typeof fetch;
  return {
    calls,
    fetchFn,
    setFail: (value: boolean) => {
      fail = value;
    },
    setStatus: (value: number) => {
      status = value;
    },
  };
};

test("the authorization server proxy caches a good answer for the TTL", async () => {
  const issuer = `https://${HOST}`;
  const up = upstream(issuer);
  let clock = 0;
  const proxy = createAuthServerMetadataProxy({
    fetch: up.fetchFn,
    now: () => clock,
  });
  const first = await proxy(issuer);
  expect(first).toEqual({
    document: { issuer, token_endpoint: `${issuer}/oauth/token` },
    ok: true,
  });
  expect(up.calls).toEqual([
    `${issuer}/.well-known/oauth-authorization-server`,
  ]);
  clock += AUTH_SERVER_METADATA_TTL_MS - 1;
  expect(await proxy(issuer)).toEqual(first);
  expect(up.calls).toHaveLength(1);
  clock += 1;
  expect(await proxy(issuer)).toEqual(first);
  expect(up.calls).toHaveLength(2);
});

test("an upstream failure is never cached and an expired entry never served", async () => {
  const issuer = `https://${HOST}`;
  const up = upstream(issuer);
  let clock = 0;
  const proxy = createAuthServerMetadataProxy({
    fetch: up.fetchFn,
    now: () => clock,
  });
  expect((await proxy(issuer)).ok).toBe(true);
  clock += AUTH_SERVER_METADATA_TTL_MS;
  up.setFail(true);
  expect(await proxy(issuer)).toEqual({ message: "fetch failed", ok: false });
  up.setFail(false);
  up.setStatus(503);
  expect((await proxy(issuer)).ok).toBe(false);
  up.setStatus(200);
  expect((await proxy(issuer)).ok).toBe(true);
  expect(up.calls).toHaveLength(4);
});

test("an oversized or non-JSON upstream answer is refused and never cached", async () => {
  const issuer = `https://${HOST}`;
  const answers = [
    // Declared too large.
    new Response(JSON.stringify({ issuer }), {
      headers: {
        "Content-Length": String(MAX_AUTH_SERVER_METADATA_BYTES + 1),
        "Content-Type": "application/json",
      },
    }),
    // Streamed too large, no Content-Length.
    new Response(
      new ReadableStream({
        start: (controller) => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                issuer,
                pad: "x".repeat(MAX_AUTH_SERVER_METADATA_BYTES),
              })
            )
          );
          controller.close();
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    ),
    new Response(`{"issuer":"${issuer}"}`, {
      headers: { "Content-Type": "text/html" },
    }),
    // A string body is text/plain.
    new Response(`{"issuer":"${issuer}"}`),
  ];
  const results = await Promise.all(
    answers.map((answer) =>
      createAuthServerMetadataProxy({
        fetch: (() => Promise.resolve(answer)) as unknown as typeof fetch,
      })(issuer)
    )
  );
  expect(results.map((result) => result.ok)).toEqual([
    false,
    false,
    false,
    false,
  ]);
  const charset = await createAuthServerMetadataProxy({
    fetch: (() =>
      Promise.resolve(
        new Response(JSON.stringify({ issuer }), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        })
      )) as unknown as typeof fetch,
  })(issuer);
  expect(charset.ok).toBe(true);
});

test("a document for another issuer is refused", async () => {
  const up = upstream("https://someone-else.example");
  const proxy = createAuthServerMetadataProxy({ fetch: up.fetchFn });
  expect((await proxy(`https://${HOST}`)).ok).toBe(false);
});
