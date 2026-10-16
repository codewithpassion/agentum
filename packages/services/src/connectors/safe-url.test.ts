import { expect, test } from "bun:test";
import { checkUrl, safeFetch } from "./safe-url.ts";

const refused: [string, string][] = [
  ["http://example.com/run", "only https"],
  ["ftp://example.com/", "only https"],
  ["https://user:pass@example.com/", "credentials"],
  ["https://user@example.com/", "credentials"],
  ["https://localhost/", "internal host name"],
  ["https://api.localhost/", "internal host name"],
  ["https://printer.local/", "internal host name"],
  ["https://db.internal/", "internal host name"],
  ["https://box.home.arpa/", "internal host name"],
  ["https://metadata/", "single-label"],
  ["https://0.0.0.0/", "private IPv4"],
  ["https://10.1.2.3/", "private IPv4"],
  ["https://100.64.0.1/", "private IPv4"],
  ["https://100.127.255.254/", "private IPv4"],
  ["https://127.0.0.1/", "private IPv4"],
  ["https://127.1/", "private IPv4"],
  ["https://0x7f000001/", "private IPv4"],
  ["https://2130706433/", "private IPv4"],
  ["https://169.254.169.254/", "private IPv4"],
  ["https://172.16.0.1/", "private IPv4"],
  ["https://172.31.255.255/", "private IPv4"],
  ["https://192.0.0.8/", "private IPv4"],
  ["https://192.168.1.1/", "private IPv4"],
  ["https://198.18.0.1/", "private IPv4"],
  ["https://224.0.0.1/", "private IPv4"],
  ["https://255.255.255.255/", "private IPv4"],
  ["https://[::]/", "private IPv6"],
  ["https://[::1]/", "private IPv6"],
  ["https://[fc00::1]/", "private IPv6"],
  ["https://[fd12:3456::1]/", "private IPv6"],
  ["https://[fe80::1]/", "private IPv6"],
  ["https://[ff02::1]/", "private IPv6"],
  ["https://[::ffff:127.0.0.1]/", "private IPv6"],
  ["https://[::ffff:10.0.0.1]/", "private IPv6"],
  ["https://[::127.0.0.1]/", "private IPv6"],
  ["https://[::a00:1]/", "private IPv6"],
  ["https://[64:ff9b::127.0.0.1]/", "private IPv6"],
  ["https://[64:ff9b::a9fe:a9fe]/", "private IPv6"],
  ["https://[2002:7f00:1::]/", "private IPv6"],
  ["https://[2002:c0a8:101::1]/", "private IPv6"],
  ["https://localhost./", "internal host name"],
  ["https://localhost../", "internal host name"],
  ["https://db.internal./", "internal host name"],
  ["https://printer.local./", "internal host name"],
  ["https://metadata./", "single-label"],
  ["https://127.0.0.1./", "private IPv4"],
  ["not a url", "not a valid URL"],
];

test.each(refused)("refuses %s", (url, reason) => {
  const result = checkUrl(url);
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.reason).toContain(reason);
});

const allowed = [
  "https://example.com/run",
  "https://jobs.example.com:8443/trigger?x=1",
  "https://8.8.8.8/",
  "https://100.63.255.255/",
  "https://100.128.0.1/",
  "https://172.15.0.1/",
  "https://172.32.0.1/",
  "https://192.169.0.1/",
  "https://[2606:4700::1111]/",
  "https://[::ffff:8.8.8.8]/",
  "https://[64:ff9b::8.8.8.8]/",
  "https://[2002:808:808::1]/",
  "https://example.com./run",
];

test.each(allowed)("allows %s", (url) => {
  expect(checkUrl(url).ok).toBe(true);
});

test("http is allowed only with the explicit flag", () => {
  expect(checkUrl("http://example.com/", { allowHttp: true }).ok).toBe(true);
  expect(checkUrl("http://127.0.0.1/", { allowHttp: true }).ok).toBe(false);
});

test("safeFetch never follows a redirect and refuses a 3xx", async () => {
  const calls: RequestInit[] = [];
  const redirecting = ((_url: string, init: RequestInit) => {
    calls.push(init);
    return Promise.resolve(Response.redirect("https://127.0.0.1/", 302));
  }) as unknown as typeof fetch;
  const result = await safeFetch(redirecting, "https://example.com/");
  expect(result).toEqual({ ok: false, reason: "redirect (302) refused" });
  expect(calls[0]?.redirect).toBe("manual");
});

test("safeFetch refuses a private URL without fetching", async () => {
  let fetched = false;
  const never = (() => {
    fetched = true;
    return Promise.resolve(new Response("ok"));
  }) as unknown as typeof fetch;
  const result = await safeFetch(never, "https://10.0.0.1/");
  expect(result.ok).toBe(false);
  expect(fetched).toBe(false);
});

test("safeFetch passes a 2xx through", async () => {
  const fine = (() =>
    Promise.resolve(
      new Response("ok", { status: 200 })
    )) as unknown as typeof fetch;
  const result = await safeFetch(fine, "https://example.com/health");
  expect(result.ok && result.response.status).toBe(200);
});

test("safeFetch gives every request a timeout and lets the abort through", async () => {
  const calls: RequestInit[] = [];
  const hangs = ((_url: string, init: RequestInit) => {
    calls.push(init);
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as unknown as typeof fetch;
  const error = await safeFetch(
    hangs,
    "https://example.com/",
    {},
    {
      timeoutMs: 5,
    }
  ).catch((caught: unknown) => caught);
  expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  expect(error).toBeInstanceOf(DOMException);
  expect((error as DOMException).name).toBe("TimeoutError");
});
