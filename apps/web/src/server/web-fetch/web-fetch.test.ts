import { describe, expect, test } from "bun:test";
import type { NetworkRequestEntry } from "@repo/services/network";
import type { ProxyMatch } from "@repo/services/secrets";
import type { WebFetchFailure, WebFetchResult } from "./types.ts";
import { createWebFetcher, type WebFetchDeps } from "./web-fetch.ts";

const OWN = ["app.example.com"];
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

type Rule = ProxyMatch & { host: string };

interface Sent {
  body: string;
  headers: Headers;
  method: string;
  url: string;
}

function harness(
  respond: (request: Request) => Response | Promise<Response>,
  options: { overrides?: Partial<WebFetchDeps>; rules?: Rule[] } = {}
) {
  const sent: Sent[] = [];
  const entries: NetworkRequestEntry[] = [];
  const logs: string[] = [];
  const announced: { host: string; names: string[] }[] = [];
  const rules = options.rules ?? [];
  const deps: WebFetchDeps = {
    announce: (host, names) => {
      announced.push({ host, names });
      return Promise.resolve();
    },
    fetch: async (request) => {
      sent.push({
        body: await request.text(),
        headers: new Headers(request.headers),
        method: request.method,
        url: request.url,
      });
      return respond(request);
    },
    log: (line) => {
      logs.push(line);
    },
    matches: async (host) =>
      rules
        .filter((rule) => rule.host === host)
        .map((rule) => ({
          header: rule.header,
          headerValue: rule.headerValue,
          name: rule.name,
          value: rule.value,
        })),
    ownHosts: OWN,
    record: (entry) => {
      entries.push(entry);
      return Promise.resolve();
    },
    via: "web_fetch",
    ...options.overrides,
  };
  return {
    announced,
    entries,
    fetcher: createWebFetcher(deps),
    logs,
    sent,
  };
}

/** Answers by URL. A URL with no answer gets a 599 the test can see. */
function byUrl(answers: Record<string, () => Response>) {
  return (request: Request): Response =>
    answers[request.url]?.() ?? new Response("unexpected", { status: 599 });
}

function redirect(status: number, location: string): Response {
  return new Response(null, { headers: { location }, status });
}

function okOf(result: WebFetchResult) {
  if (!result.ok) {
    throw new Error(`expected an answer, got ${result.error}`);
  }
  return result;
}

function errorOf(result: WebFetchResult): WebFetchFailure {
  if (result.ok) {
    throw new Error("expected a failure");
  }
  return result.error;
}

function streamOf(...chunks: number[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const size of chunks) {
        controller.enqueue(new Uint8Array(size));
      }
      controller.close();
    },
  });
}

describe("createWebFetcher sends requests", () => {
  test("a plain GET returns the answer and records one entry", async () => {
    const h = harness(
      () => new Response("hello", { headers: { "Content-Type": "text/plain" } })
    );
    const result = okOf(await h.fetcher({ url: "https://a.example/page?x=1" }));
    expect(decode(result.bytes)).toBe("hello");
    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBe("text/plain");
    expect(result.url).toBe("https://a.example/page?x=1");
    expect(h.entries).toHaveLength(1);
    expect(h.entries[0]).toMatchObject({
      bytes: 5,
      host: "a.example",
      method: "GET",
      status: 200,
      via: "web_fetch",
    });
  });

  test("HEAD returns no body", async () => {
    const h = harness(
      () =>
        new Response(null, {
          headers: { "Content-Length": "1000" },
          status: 200,
        })
    );
    const result = okOf(
      await h.fetcher({ method: "head", url: "https://a.example/" })
    );
    expect(h.sent[0]?.method).toBe("HEAD");
    expect(result.bytes.byteLength).toBe(0);
    expect(h.entries[0]?.method).toBe("HEAD");
  });

  test("POST sends the body and the caller's headers", async () => {
    const h = harness(() => new Response("made", { status: 201 }));
    const result = okOf(
      await h.fetcher({
        body: new TextEncoder().encode("payload"),
        headers: { "X-Trace": "t1" },
        method: "post",
        url: "https://a.example/items",
      })
    );
    expect(result.status).toBe(201);
    expect(h.sent[0]?.method).toBe("POST");
    expect(h.sent[0]?.body).toBe("payload");
    expect(h.sent[0]?.headers.get("x-trace")).toBe("t1");
  });

  test("a 204 answer carries no body", async () => {
    const h = harness(() => new Response(null, { status: 204 }));
    const result = okOf(await h.fetcher({ url: "https://a.example/" }));
    expect(result.status).toBe(204);
    expect(result.bytes.byteLength).toBe(0);
  });

  test("hop headers from the caller are not sent", async () => {
    const h = harness(() => new Response("ok"));
    await h.fetcher({
      headers: {
        "CF-Connecting-IP": "1.2.3.4",
        Host: "evil.example",
        "X-Keep": "yes",
        "X-Real-IP": "5.6.7.8",
      },
      url: "https://a.example/",
    });
    expect(h.sent[0]?.headers.get("host")).toBeNull();
    expect(h.sent[0]?.headers.get("cf-connecting-ip")).toBeNull();
    expect(h.sent[0]?.headers.get("x-real-ip")).toBeNull();
    expect(h.sent[0]?.headers.get("x-keep")).toBe("yes");
  });
});

describe("createWebFetcher refuses bad requests before sending", () => {
  for (const request of [
    { method: "BREW", url: "https://a.example/" },
    { body: new Uint8Array([1]), method: "GET", url: "https://a.example/" },
    { body: new Uint8Array([1]), method: "head", url: "https://a.example/" },
    { headers: { "x-bad": "a\nb" }, url: "https://a.example/" },
  ]) {
    test(`${request.method ?? "GET"} with ${Object.keys(request).join(",")}`, async () => {
      const h = harness(() => new Response("never"));
      expect(errorOf(await h.fetcher(request))).toBe("bad_request");
      expect(h.sent).toHaveLength(0);
    });
  }
});

describe("createWebFetcher refuses unsafe targets", () => {
  test("a private address at hop 0 is blocked and recorded", async () => {
    const h = harness(() => new Response("never"));
    const result = await h.fetcher({
      url: "http://127.0.0.1/admin?token=QUERYVAL",
    });
    expect(errorOf(result)).toBe("blocked");
    expect(h.sent).toHaveLength(0);
    expect(h.entries).toEqual([
      {
        blocked: expect.any(String),
        bytes: 0,
        durationMs: expect.any(Number),
        host: "127.0.0.1",
        method: "GET",
        status: null,
        via: "web_fetch",
      },
    ]);
  });

  for (const location of [
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "//localhost/x",
    "https://app.example.com/",
  ]) {
    test(`a redirect to ${location} is blocked and never sent`, async () => {
      const h = harness(
        byUrl({
          "https://a.example/start": () => redirect(302, location),
        })
      );
      const result = await h.fetcher({ url: "https://a.example/start" });
      expect(errorOf(result)).toBe("blocked");
      expect(h.sent.map((sent) => sent.url)).toEqual([
        "https://a.example/start",
      ]);
      // One entry for the redirect hop that was sent, one for the refused target.
      expect(h.entries.map((entry) => entry.status)).toEqual([302, null]);
      expect(h.entries[1]?.blocked).toEqual(expect.any(String));
    });
  }
});

describe("createWebFetcher follows redirects", () => {
  test("a relative Location is followed", async () => {
    const h = harness(
      byUrl({
        "https://a.example/final": () => new Response("done"),
        "https://a.example/start": () => redirect(302, "/final"),
      })
    );
    const result = okOf(await h.fetcher({ url: "https://a.example/start" }));
    expect(result.url).toBe("https://a.example/final");
    expect(decode(result.bytes)).toBe("done");
    expect(h.entries.map((entry) => entry.status)).toEqual([302, 200]);
    expect(h.entries[0]?.bytes).toBe(0);
  });

  test("a chain over maxRedirects is too_many_redirects", async () => {
    const h = harness(() => redirect(302, "/next"), {
      overrides: { maxRedirects: 2 },
    });
    expect(errorOf(await h.fetcher({ url: "https://a.example/" }))).toBe(
      "too_many_redirects"
    );
    expect(h.sent).toHaveLength(3);
  });

  test("301 on a POST becomes a GET with no body", async () => {
    const h = harness(
      byUrl({
        "https://a.example/final": () => new Response("done"),
        "https://a.example/start": () => redirect(301, "/final"),
      })
    );
    okOf(
      await h.fetcher({
        body: new TextEncoder().encode("payload"),
        method: "POST",
        url: "https://a.example/start",
      })
    );
    expect(h.sent[1]?.method).toBe("GET");
    expect(h.sent[1]?.body).toBe("");
  });

  test("303 on a POST becomes a GET with no body", async () => {
    const h = harness(
      byUrl({
        "https://a.example/final": () => new Response("done"),
        "https://a.example/start": () => redirect(303, "/final"),
      })
    );
    okOf(
      await h.fetcher({
        body: new TextEncoder().encode("payload"),
        method: "POST",
        url: "https://a.example/start",
      })
    );
    expect(h.sent[1]?.method).toBe("GET");
    expect(h.sent[1]?.body).toBe("");
  });

  test("307 keeps the method and the body", async () => {
    const h = harness(
      byUrl({
        "https://a.example/final": () => new Response("done"),
        "https://a.example/start": () => redirect(307, "/final"),
      })
    );
    okOf(
      await h.fetcher({
        body: new TextEncoder().encode("payload"),
        method: "POST",
        url: "https://a.example/start",
      })
    );
    expect(h.sent[1]?.method).toBe("POST");
    expect(h.sent[1]?.body).toBe("payload");
  });

  test("a 3xx without Location is the answer", async () => {
    const h = harness(() => new Response("moved nowhere", { status: 302 }));
    const result = okOf(await h.fetcher({ url: "https://a.example/" }));
    expect(result.status).toBe(302);
    expect(h.sent).toHaveLength(1);
  });

  test("caller authorization and cookie stay on the same host and are dropped on another", async () => {
    const h = harness(
      byUrl({
        "https://a.example/same": () => redirect(302, "https://b.example/end"),
        "https://a.example/start": () => redirect(302, "/same"),
        "https://b.example/end": () => new Response("done"),
      })
    );
    okOf(
      await h.fetcher({
        headers: { Authorization: "Bearer CALLER", Cookie: "session=abc" },
        url: "https://a.example/start",
      })
    );
    expect(h.sent[0]?.headers.get("authorization")).toBe("Bearer CALLER");
    expect(h.sent[1]?.headers.get("authorization")).toBe("Bearer CALLER");
    expect(h.sent[1]?.headers.get("cookie")).toBe("session=abc");
    expect(h.sent[2]?.url).toBe("https://b.example/end");
    expect(h.sent[2]?.headers.get("authorization")).toBeNull();
    expect(h.sent[2]?.headers.get("cookie")).toBeNull();
  });

  test.each([
    ["an https to http downgrade on the same host", "http://a.example/end"],
    ["a port change on the same host", "https://a.example:8443/end"],
  ])(
    "caller authorization and cookie are dropped on %s",
    async (_name, target) => {
      const h = harness(
        byUrl({
          "https://a.example/start": () => redirect(302, target),
          [target]: () => new Response("done"),
        })
      );
      okOf(
        await h.fetcher({
          headers: { Authorization: "Bearer CALLER", Cookie: "session=abc" },
          url: "https://a.example/start",
        })
      );
      expect(h.sent[0]?.headers.get("authorization")).toBe("Bearer CALLER");
      expect(h.sent[1]?.url).toBe(target);
      expect(h.sent[1]?.headers.get("authorization")).toBeNull();
      expect(h.sent[1]?.headers.get("cookie")).toBeNull();
    }
  );

  test("a POST turned into a GET drops its content-type with its body", async () => {
    const h = harness(
      byUrl({
        "https://a.example/end": () => new Response("done"),
        "https://a.example/start": () => redirect(302, "/end"),
      })
    );
    okOf(
      await h.fetcher({
        body: new TextEncoder().encode("a=b"),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
        url: "https://a.example/start",
      })
    );
    expect(h.sent[1]?.method).toBe("GET");
    expect(h.sent[1]?.headers.get("content-type")).toBeNull();
  });
});

describe("createWebFetcher adds credentials per hop", () => {
  const rule: Rule = {
    header: "x-api-key",
    headerValue: "SECRET-A",
    host: "a.example",
    name: "A key",
    value: "SECRET-A",
  };

  test("a rule for host A adds its header on A only", async () => {
    const h = harness(
      byUrl({
        "https://a.example/start": () => redirect(302, "https://b.example/end"),
        "https://b.example/end": () => new Response("done"),
      }),
      { rules: [rule] }
    );
    okOf(await h.fetcher({ url: "https://a.example/start" }));
    expect(h.sent[0]?.headers.get("x-api-key")).toBe("SECRET-A");
    expect(h.sent[1]?.headers.get("x-api-key")).toBeNull();
    expect(h.announced).toEqual([{ host: "a.example", names: ["A key"] }]);
  });

  test("announce is called once per matching hop", async () => {
    const h = harness(
      byUrl({
        "https://a.example/next": () => new Response("done"),
        "https://a.example/start": () => redirect(302, "/next"),
      }),
      { rules: [rule] }
    );
    okOf(await h.fetcher({ url: "https://a.example/start" }));
    expect(h.sent.map((sent) => sent.headers.get("x-api-key"))).toEqual([
      "SECRET-A",
      "SECRET-A",
    ]);
    expect(h.announced).toHaveLength(2);
  });

  test("a rule does not send its header over http", async () => {
    const h = harness(() => new Response("never"), { rules: [rule] });
    const result = okOf(await h.fetcher({ url: "http://a.example/x" }));
    expect(result.status).toBe(403);
    expect(h.sent).toHaveLength(0);
    expect(h.announced).toHaveLength(0);
  });
});

describe("createWebFetcher caps the answer", () => {
  test("a body of exactly maxBytes passes", async () => {
    const h = harness(() => new Response(streamOf(4, 6)), {
      overrides: { maxBytes: 10 },
    });
    const result = okOf(await h.fetcher({ url: "https://a.example/" }));
    expect(result.bytes.byteLength).toBe(10);
  });

  test("a body one byte over maxBytes is too_large", async () => {
    const h = harness(() => new Response(streamOf(4, 7)), {
      overrides: { maxBytes: 10 },
    });
    const result = await h.fetcher({ url: "https://a.example/" });
    expect(errorOf(result)).toBe("too_large");
    expect(h.entries[0]?.status).toBe(200);
  });
});

describe("createWebFetcher ends with a failure", () => {
  test("a fetch that waits until its signal aborts times out", async () => {
    const h = harness(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        }),
      { overrides: { timeoutMs: 20 } }
    );
    const result = await h.fetcher({ url: "https://a.example/" });
    expect(errorOf(result)).toBe("timeout");
    expect(h.entries[0]?.status).toBeNull();
  });

  test("the caller's signal aborts the call as a timeout", async () => {
    const controller = new AbortController();
    const h = harness(
      (request) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () =>
            reject(new Error("aborted"))
          );
        })
    );
    setTimeout(() => controller.abort(), 10);
    const result = await h.fetcher({
      signal: controller.signal,
      url: "https://a.example/",
    });
    expect(errorOf(result)).toBe("timeout");
  });

  test("a thrown fetch is unreachable, and its message is not passed on", async () => {
    const h = harness(() => {
      throw new Error("connect failed for https://a.example/?token=QUERYVAL");
    });
    const result = await h.fetcher({
      url: "https://a.example/?token=QUERYVAL",
    });
    expect(errorOf(result)).toBe("unreachable");
    if (result.ok) {
      throw new Error("expected a failure");
    }
    expect(result.message).not.toContain("QUERYVAL");
    expect(h.entries[0]?.status).toBeNull();
  });
});

describe("createWebFetcher records the network entries", () => {
  test("an entry holds exactly the logged keys and no path, query, header or body", async () => {
    const h = harness(() => new Response("answer", { status: 200 }));
    await h.fetcher({
      body: new TextEncoder().encode("BODYVAL"),
      headers: { "X-Api-Key": "HDRVAL" },
      method: "POST",
      url: "https://a.example/secret/path?token=QUERYVAL",
    });
    await h.fetcher({ url: "http://127.0.0.1/secret/path?token=QUERYVAL" });
    expect(h.entries).toHaveLength(2);
    expect(Object.keys(h.entries[0] ?? {}).sort()).toEqual([
      "bytes",
      "durationMs",
      "host",
      "method",
      "status",
      "via",
    ]);
    expect(Object.keys(h.entries[1] ?? {}).sort()).toEqual([
      "blocked",
      "bytes",
      "durationMs",
      "host",
      "method",
      "status",
      "via",
    ]);
    const logged = JSON.stringify(h.entries);
    for (const secret of ["secret/path", "QUERYVAL", "HDRVAL", "BODYVAL"]) {
      expect(logged).not.toContain(secret);
    }
  });

  test("a record that rejects does not fail the call", async () => {
    const h = harness(() => new Response("ok"), {
      overrides: {
        record: () => Promise.reject(new Error("database is down")),
      },
    });
    const result = okOf(await h.fetcher({ url: "https://a.example/" }));
    expect(decode(result.bytes)).toBe("ok");
    expect(h.logs).toEqual(["web fetch: recording the request failed"]);
  });
});

const REAL = "sk-real-0123456789";
const PLACEHOLDER = "hm-secret:SUPADATA_KEY";
const supadataGrant = (hosts: string[]) => ({
  hosts,
  name: "SUPADATA_KEY",
  value: REAL,
});
const withGrants = (grants: ReturnType<typeof supadataGrant>[]) => ({
  envGrants: () => Promise.resolve(grants),
});

describe("createWebFetcher fills env secret placeholders", () => {
  test("a placeholder in the header, query and text body is filled for an allowed host", async () => {
    const h = harness(() => new Response("ok"), {
      overrides: withGrants([supadataGrant(["api.supadata.ai"])]),
    });
    const result = okOf(
      await h.fetcher({
        body: new TextEncoder().encode(`{"key":"${PLACEHOLDER}"}`),
        headers: { Authorization: `Bearer ${PLACEHOLDER}` },
        method: "POST",
        url: `https://api.supadata.ai/v1/transcript?api_key=${PLACEHOLDER}`,
      })
    );
    expect(h.sent[0]?.url).toBe(
      `https://api.supadata.ai/v1/transcript?api_key=${REAL}`
    );
    expect(h.sent[0]?.headers.get("authorization")).toBe(`Bearer ${REAL}`);
    expect(h.sent[0]?.body).toBe(`{"key":"${REAL}"}`);
    expect(result.url).toBe(
      `https://api.supadata.ai/v1/transcript?api_key=${PLACEHOLDER}`
    );
  });

  test("a wildcard host grant fills the value", async () => {
    const h = harness(() => new Response("ok"), {
      overrides: withGrants([supadataGrant(["*.supadata.ai"])]),
    });
    okOf(
      await h.fetcher({
        headers: { "X-Key": PLACEHOLDER },
        url: "https://api.supadata.ai/",
      })
    );
    expect(h.sent[0]?.headers.get("x-key")).toBe(REAL);
  });

  test("a host the secret may not reach is refused without a send, and recorded", async () => {
    const h = harness(() => new Response("never"), {
      overrides: withGrants([supadataGrant(["api.supadata.ai"])]),
    });
    const result = await h.fetcher({
      headers: { "X-Key": PLACEHOLDER },
      url: "https://example.com/",
    });
    expect(h.sent).toHaveLength(0);
    expect(result).toMatchObject({
      error: "blocked",
      message: expect.stringContaining(
        "SUPADATA_KEY may only be sent to api.supadata.ai"
      ),
      ok: false,
    });
    expect(h.entries).toEqual([
      {
        blocked: "SUPADATA_KEY may only be sent to api.supadata.ai",
        bytes: 0,
        durationMs: expect.any(Number),
        host: "example.com",
        method: "GET",
        status: null,
        via: "web_fetch",
      },
    ]);
  });

  test("a grant with no hosts refuses the value", async () => {
    const h = harness(() => new Response("never"), {
      overrides: withGrants([supadataGrant([])]),
    });
    const result = await h.fetcher({
      headers: { "X-Key": PLACEHOLDER },
      url: "https://api.supadata.ai/",
    });
    expect(h.sent).toHaveLength(0);
    expect(result).toMatchObject({
      error: "blocked",
      message: expect.stringContaining(
        "SUPADATA_KEY has no allowed hosts. Add them in Settings, Secrets."
      ),
    });
  });

  test("a name that is not granted is refused", async () => {
    const h = harness(() => new Response("never"), {
      overrides: withGrants([supadataGrant(["api.supadata.ai"])]),
    });
    const result = await h.fetcher({
      url: "https://api.supadata.ai/?k=hm-secret:OTHER_KEY",
    });
    expect(h.sent).toHaveLength(0);
    expect(result).toMatchObject({
      error: "blocked",
      message: expect.stringContaining(
        "OTHER_KEY is not granted to this agent"
      ),
    });
  });

  test("a placeholder is refused when envGrants is not given", async () => {
    const h = harness(() => new Response("never"));
    const result = await h.fetcher({
      headers: { "X-Key": PLACEHOLDER },
      url: "https://api.supadata.ai/",
    });
    expect(h.sent).toHaveLength(0);
    expect(result).toMatchObject({
      error: "blocked",
      message: expect.stringContaining(
        "SUPADATA_KEY is not granted to this agent"
      ),
    });
  });

  test("a placeholder is refused over http", async () => {
    const h = harness(() => new Response("never"), {
      overrides: withGrants([supadataGrant(["api.supadata.ai"])]),
    });
    const result = await h.fetcher({
      headers: { "X-Key": PLACEHOLDER },
      url: "http://api.supadata.ai/",
    });
    expect(h.sent).toHaveLength(0);
    expect(result).toMatchObject({
      error: "blocked",
      message: expect.stringContaining("A secret is only sent over https"),
    });
  });

  test("a 307 redirect from the allowed host to another host is refused before the second send", async () => {
    const h = harness(
      byUrl({
        "https://api.supadata.ai/start": () =>
          redirect(307, "https://example.com/next"),
      }),
      { overrides: withGrants([supadataGrant(["api.supadata.ai"])]) }
    );
    const result = await h.fetcher({
      body: new TextEncoder().encode(`payload ${PLACEHOLDER}`),
      headers: { "X-Key": PLACEHOLDER },
      method: "POST",
      url: "https://api.supadata.ai/start",
    });
    expect(errorOf(result)).toBe("blocked");
    expect(h.sent.map((sent) => sent.url)).toEqual([
      "https://api.supadata.ai/start",
    ]);
    expect(h.sent[0]?.headers.get("x-key")).toBe(REAL);
    expect(h.sent[0]?.body).toBe(`payload ${REAL}`);
    expect(h.entries.map((entry) => entry.host)).toEqual([
      "api.supadata.ai",
      "example.com",
    ]);
    expect(h.entries[1]?.blocked).toBe(
      "SUPADATA_KEY may only be sent to api.supadata.ai"
    );
  });

  test("a 307 redirect to another path on the allowed host fills the value again", async () => {
    const h = harness(
      byUrl({
        "https://api.supadata.ai/next": () => new Response("done"),
        "https://api.supadata.ai/start": () => redirect(307, "/next"),
      }),
      { overrides: withGrants([supadataGrant(["api.supadata.ai"])]) }
    );
    const result = okOf(
      await h.fetcher({
        headers: { "X-Key": PLACEHOLDER },
        url: "https://api.supadata.ai/start",
      })
    );
    expect(result.url).toBe("https://api.supadata.ai/next");
    expect(h.sent.map((sent) => sent.headers.get("x-key"))).toEqual([
      REAL,
      REAL,
    ]);
  });

  test("a redirect whose Location echoes the value is followed from the placeholder form and refused for another host", async () => {
    const h = harness(
      byUrl({
        [`https://api.supadata.ai/v1?key=${REAL}`]: () =>
          redirect(301, `https://cdn.other.example/x?key=${REAL}`),
      }),
      { overrides: withGrants([supadataGrant(["api.supadata.ai"])]) }
    );
    const result = await h.fetcher({
      url: `https://api.supadata.ai/v1?key=${PLACEHOLDER}`,
    });
    expect(errorOf(result)).toBe("blocked");
    expect(h.sent.map((sent) => sent.url)).toEqual([
      `https://api.supadata.ai/v1?key=${REAL}`,
    ]);
    expect(h.entries[1]?.blocked).toBe(
      "SUPADATA_KEY may only be sent to api.supadata.ai"
    );
    expect(JSON.stringify([result, h.entries, h.logs])).not.toContain(REAL);
  });

  test("a same-host redirect that echoes the value fills it again and the result url shows the placeholder", async () => {
    const h = harness(
      byUrl({
        [`https://api.supadata.ai/v1?key=${REAL}`]: () =>
          redirect(301, `/v1/?key=${encodeURIComponent(REAL)}`),
        [`https://api.supadata.ai/v1/?key=${REAL}`]: () => new Response("done"),
      }),
      { overrides: withGrants([supadataGrant(["api.supadata.ai"])]) }
    );
    const result = okOf(
      await h.fetcher({ url: `https://api.supadata.ai/v1?key=${PLACEHOLDER}` })
    );
    expect(result.url).toBe(`https://api.supadata.ai/v1/?key=${PLACEHOLDER}`);
    expect(JSON.stringify(result.url)).not.toContain(REAL);
    expect(h.sent).toHaveLength(2);
  });

  test("announce gets the host and the secret names only", async () => {
    const h = harness(() => new Response("ok"), {
      overrides: withGrants([supadataGrant(["api.supadata.ai"])]),
    });
    okOf(
      await h.fetcher({
        headers: { "X-Key": PLACEHOLDER },
        url: `https://api.supadata.ai/?k=${PLACEHOLDER}`,
      })
    );
    expect(h.announced).toEqual([
      { host: "api.supadata.ai", names: ["SUPADATA_KEY"] },
    ]);
  });

  test("a failing announce is logged with a fixed line and the send still happens", async () => {
    const h = harness(() => new Response("ok"), {
      overrides: {
        ...withGrants([supadataGrant(["api.supadata.ai"])]),
        announce: () => Promise.reject(new Error(`down ${REAL}`)),
      },
    });
    okOf(
      await h.fetcher({
        headers: { "X-Key": PLACEHOLDER },
        url: "https://api.supadata.ai/",
      })
    );
    expect(h.sent[0]?.headers.get("x-key")).toBe(REAL);
    expect(h.logs).toEqual(["web fetch: recording the event failed"]);
  });

  test("a hop with no placeholder is sent unchanged and reads no grants", async () => {
    let grantReads = 0;
    const h = harness(() => new Response("ok"), {
      overrides: {
        envGrants: () => {
          grantReads += 1;
          return Promise.resolve([supadataGrant(["api.supadata.ai"])]);
        },
      },
    });
    okOf(
      await h.fetcher({
        body: new TextEncoder().encode("plain"),
        headers: { "X-Key": "plain-value" },
        method: "POST",
        url: "https://api.supadata.ai/?q=1",
      })
    );
    expect(grantReads).toBe(0);
    expect(h.announced).toEqual([]);
    expect(h.sent[0]?.url).toBe("https://api.supadata.ai/?q=1");
    expect(h.sent[0]?.headers.get("x-key")).toBe("plain-value");
    expect(h.sent[0]?.body).toBe("plain");
  });

  test("the real value is in no refusal, announce, entry or log line", async () => {
    const h = harness(
      byUrl({
        "https://api.supadata.ai/start": () =>
          redirect(307, "https://example.com/next"),
      }),
      {
        overrides: {
          ...withGrants([supadataGrant(["api.supadata.ai"])]),
          announce: () => Promise.reject(new Error(`down ${REAL}`)),
        },
      }
    );
    const redirected = await h.fetcher({
      headers: { "X-Key": PLACEHOLDER },
      url: "https://api.supadata.ai/start",
    });
    const refused = await h.fetcher({
      headers: { "X-Key": PLACEHOLDER },
      url: "https://example.com/",
    });
    const seen = JSON.stringify([
      redirected,
      refused,
      h.announced,
      h.entries,
      h.logs,
    ]);
    expect(h.sent[0]?.headers.get("x-key")).toBe(REAL);
    expect(seen).not.toContain(REAL);
  });
});
