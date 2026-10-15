import { expect, test } from "bun:test";
import { sanitizeUrl, stripSecrets } from "./redact.ts";

test("redacts headers, nested payloads and credential values without mutation", () => {
  const value = {
    headers: {
      Authorization: "Bearer secret",
      Cookie: "session",
      "x-api-key": "secret",
    },
    payload: [
      {
        password: "secret",
        safe: "repo",
        url: "https://user:pass@example.com",
      },
    ],
    value: "hm_run_abcdefghijklmnop",
  };
  expect(stripSecrets(value)).toEqual({
    headers: {
      Authorization: "[redacted]",
      Cookie: "[redacted]",
      "x-api-key": "[redacted]",
    },
    payload: [
      {
        password: "[redacted]",
        safe: "repo",
        url: "https://[redacted]@example.com",
      },
    ],
    value: "[redacted]",
  });
  expect(value.headers.Cookie).toBe("session");
});

test("redacts a Harbourmaster key token in a string value", () => {
  expect(
    stripSecrets({ note: "hm_key_abcdefghijklmnop", safe: "hm_key_short" })
  ).toEqual({ note: "[redacted]", safe: "hm_key_short" });
});

test("redacts credential suffixes with numeric versions and preserves ordinary fields", () => {
  expect(
    stripSecrets({
      access_token2: "secret",
      apiKey42: "secret",
      author: "Alice",
      dbPassword1: "secret",
      max_tokens: 100,
      privateKey9: "secret",
      serviceSecret3: "secret",
      xhubsignature256: "secret",
    })
  ).toEqual({
    access_token2: "[redacted]",
    apiKey42: "[redacted]",
    author: "Alice",
    dbPassword1: "[redacted]",
    max_tokens: 100,
    privateKey9: "[redacted]",
    serviceSecret3: "[redacted]",
    xhubsignature256: "[redacted]",
  });
});

test("URL query secrets are stripped from helpers and nested payloads", () => {
  const url = "https://example.com/run?token=ghp_x&ok=1";
  expect(sanitizeUrl(url)).toBe("https://example.com/run?ok=1");
  expect(stripSecrets({ nested: [url] })).toEqual({
    nested: ["https://example.com/run?ok=1"],
  });
  for (const key of [
    "token",
    "access_token",
    "auth",
    "sig",
    "signature",
    "key",
    "secret",
    "password",
    "credential",
    "service_auth",
    "deploy_sig",
    "my_key",
    "user_credential",
  ]) {
    expect(sanitizeUrl(`https://example.com/?${key}=secret&ok=1`)).toBe(
      "https://example.com/?ok=1"
    );
  }
  const long = `https://example.com/?token=${"x".repeat(2048)}`;
  expect(sanitizeUrl(long)).toBe("https://example.com/");
  expect(sanitizeUrl("ftp://example.com/?token=secret")).toBe(
    "ftp://example.com/?token=secret"
  );
});

test("URL-only code and jwt secrets are stripped in uppercase schemes and fragments", () => {
  expect(
    sanitizeUrl(
      "HTTPS://example.com/?code=x&jwt=x&ok=1#access_token=x&code=y&jwt=z&state=s"
    )
  ).toBe("https://example.com/?ok=1#state=s");
  expect(stripSecrets({ code: "abc", jwt: "abc" })).toEqual({
    code: "abc",
    jwt: "abc",
  });
});
// Timing bounds are generous because CI runners are slower than dev
// machines; they exist to catch quadratic regressions, which take seconds.
test("215 secret parameters in a 2 KB URL are filtered in linear time", () => {
  const url = `https://example.com/?${Array.from({ length: 215 }, () => "token=x").join("&")}&safe=${"a".repeat(300)}`;
  expect(url.length).toBeLessThanOrEqual(2048);
  for (let i = 0; i < 100; i += 1) {
    sanitizeUrl(url);
  }
  const start = performance.now();
  for (let i = 0; i < 100; i += 1) {
    sanitizeUrl(url);
  }
  expect((performance.now() - start) / 100).toBeLessThan(5);
  expect(sanitizeUrl(url)).toBe(`https://example.com/?safe=${"a".repeat(300)}`);
});

test("stripping query secrets preserves ordinary URL fragments", () => {
  expect(sanitizeUrl("https://example.com/?token=x#section")).toBe(
    "https://example.com/#section"
  );
  expect(sanitizeUrl("https://example.com/?q=a%20b#token=x")).toBe(
    "https://example.com/?q=a%20b"
  );
});

test("URL parsing sanitizes noncanonical schemes and fragment routes", () => {
  for (const value of [
    " https://e.com/?token=x",
    "https:e.com/?token=x",
    "ht\ttps://e.com/?token=x",
  ]) {
    expect(sanitizeUrl(value)).toBe("https://e.com/");
  }
  expect(sanitizeUrl("https://e.com/#/cb?code=1&ok=2")).toBe(
    "https://e.com/#/cb?ok=2"
  );
});

test("stripSecrets handles 100k plain strings without URL parsing each one", () => {
  const values = Array.from(
    { length: 100_000 },
    (_, i) => `ordinary event ${i}`
  );
  stripSecrets(values);
  const start = performance.now();
  const result = stripSecrets(values);
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(250);
  expect(result).toEqual(values);
});
