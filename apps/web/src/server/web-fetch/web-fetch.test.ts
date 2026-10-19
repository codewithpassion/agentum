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
