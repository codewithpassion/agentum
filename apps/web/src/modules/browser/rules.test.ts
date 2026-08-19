import { describe, expect, test } from "bun:test";
import {
  isSessionStale,
  KEEP_ALIVE_MS,
  MAX_FILL_VALUE_LENGTH,
  MAX_SELECTOR_LENGTH,
  MAX_URL_LENGTH,
  screenshotKey,
  validateFillValue,
  validateSelector,
  validateUrl,
} from "./rules";

describe("validateUrl", () => {
  test("accepts http and https, keeping path and query", () => {
    expect(validateUrl("https://example.com/docs?q=1")).toEqual({
      ok: true,
      url: "https://example.com/docs?q=1",
    });
    expect(validateUrl("  http://example.com  ")).toEqual({
      ok: true,
      url: "http://example.com/",
    });
  });

  test("refuses schemes other than http and https", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<h1>hi</h1>",
      "ftp://example.com",
    ]) {
      expect(validateUrl(url).ok).toBe(false);
    }
  });

  test("refuses loopback and private hosts by name", () => {
    for (const url of [
      "http://localhost:8787/admin",
      "http://app.localhost/",
      "http://printer.local/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://db.home.arpa/",
    ]) {
      expect(validateUrl(url).ok).toBe(false);
    }
  });

  test("refuses reserved IPv4 literals, including cloud metadata", () => {
    for (const url of [
      "http://127.0.0.1:3000/",
      "http://0.0.0.0/",
      "http://10.1.2.3/",
      "http://172.16.0.1/",
      "http://172.31.255.254/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://100.100.0.1/",
    ]) {
      expect(validateUrl(url).ok).toBe(false);
    }
  });

  test("still allows public addresses that neighbour reserved ranges", () => {
    for (const url of [
      "http://172.32.0.1/",
      "http://172.15.0.1/",
      "http://192.169.1.1/",
      "http://8.8.8.8/",
      "http://169.253.0.1/",
    ]) {
      expect(validateUrl(url).ok).toBe(true);
    }
  });

  test("refuses IPv6 literals outright", () => {
    expect(validateUrl("http://[::1]/").ok).toBe(false);
    expect(validateUrl("http://[fd00::1]/").ok).toBe(false);
    expect(validateUrl("http://[2606:4700::1111]/").ok).toBe(false);
  });

  test("refuses credentials in the URL", () => {
    expect(validateUrl("https://user:pass@example.com/").ok).toBe(false);
  });

  test("refuses what is not a URL at all", () => {
    expect(validateUrl("example.com").ok).toBe(false);
    expect(validateUrl("").ok).toBe(false);
    expect(validateUrl(undefined).ok).toBe(false);
    expect(validateUrl(42).ok).toBe(false);
  });

  test("refuses a URL over the length cap", () => {
    const long = `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`;
    expect(validateUrl(long).ok).toBe(false);
  });
});

describe("validateSelector", () => {
  test("trims and accepts a selector", () => {
    expect(validateSelector("  #submit  ")).toEqual({
      ok: true,
      value: "#submit",
    });
  });

  test("refuses empty and oversized selectors", () => {
    expect(validateSelector("   ").ok).toBe(false);
    expect(validateSelector(null).ok).toBe(false);
    expect(validateSelector("a".repeat(MAX_SELECTOR_LENGTH + 1)).ok).toBe(
      false
    );
  });
});

describe("validateFillValue", () => {
  test("accepts an empty string, which clears the field", () => {
    expect(validateFillValue("")).toEqual({ ok: true, value: "" });
  });

  test("keeps surrounding whitespace, which the field may need", () => {
    expect(validateFillValue(" padded ")).toEqual({
      ok: true,
      value: " padded ",
    });
  });

  test("refuses non-strings and oversized values", () => {
    expect(validateFillValue(undefined).ok).toBe(false);
    expect(validateFillValue("a".repeat(MAX_FILL_VALUE_LENGTH + 1)).ok).toBe(
      false
    );
  });
});

describe("isSessionStale", () => {
  const now = 1_700_000_000_000;

  test("a session used moments ago is live", () => {
    expect(isSessionStale(now - 1000, now)).toBe(false);
  });

  test("a session idle past the keep-alive window is gone", () => {
    expect(isSessionStale(now - KEEP_ALIVE_MS - 1, now)).toBe(true);
  });

  test("treats the last seconds before the deadline as gone", () => {
    // Reconnecting there costs a round trip and then fails anyway.
    expect(isSessionStale(now - (KEEP_ALIVE_MS - 5000), now)).toBe(true);
  });

  test("a timestamp from the future is a clock disagreeing, not a stale row", () => {
    expect(isSessionStale(now + 60_000, now)).toBe(false);
  });
});

describe("screenshotKey", () => {
  test("namespaces by agent and sorts by time", () => {
    expect(screenshotKey("agent-1", 1_700_000_000_000, "ab12cd34")).toBe(
      "browser/agent-1/1700000000000-ab12cd34.png"
    );
  });

  test("two screenshots in the same millisecond get different keys", () => {
    const first = screenshotKey("agent-1", 1000, "aaaa");
    const second = screenshotKey("agent-1", 1000, "bbbb");
    expect(first).not.toBe(second);
  });
});
