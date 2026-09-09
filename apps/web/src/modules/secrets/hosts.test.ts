import { describe, expect, test } from "bun:test";
import {
  hostMatches,
  isPrivateHost,
  MAX_ALLOWED_HOSTS,
  parseAllowedHost,
  parseAllowedHosts,
} from "./hosts";

/**
 * The allowlist is the real control on where a secret can go - redaction and
 * the header-only injection are the belt to its braces - so these are the
 * tests that matter most in the module.
 */

const hostOf = (entry: string): string | null => {
  const parsed = parseAllowedHost(entry);
  return parsed.ok ? parsed.host : null;
};

const reasonOf = (entry: string): string | null => {
  const parsed = parseAllowedHost(entry);
  return parsed.ok ? null : parsed.reason;
};

describe("parseAllowedHost", () => {
  test.each([
    ["api.deepgram.com", "api.deepgram.com"],
    ["*.deepgram.com", "*.deepgram.com"],
    ["a.b.c.example.co.uk", "a.b.c.example.co.uk"],
    ["203.0.113.7", "203.0.113.7"],
    ["xn--80ak6aa92e.com", "xn--80ak6aa92e.com"],
  ])("accepts %p", (entry, expected) => {
    expect(hostOf(entry)).toBe(expected);
  });

  test.each([
    ["  API.Deepgram.COM  ", "api.deepgram.com"],
    ["api.deepgram.com.", "api.deepgram.com"],
    ["*.Deepgram.com", "*.deepgram.com"],
  ])("normalizes %p", (entry, expected) => {
    expect(hostOf(entry)).toBe(expected);
  });

  test.each([
    "https://api.deepgram.com",
    "api.deepgram.com/v1/listen",
    "api.deepgram.com:443",
    "user@api.deepgram.com",
    "[::1]",
    "2001:db8::1",
  ])("refuses %p - not a bare host", (entry) => {
    expect(reasonOf(entry)).toBeTruthy();
  });

  test.each([
    "127.0.0.1",
    "10.0.0.5",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "localhost",
    "db.internal",
    "printer.local",
    "box.home.arpa",
  ])("refuses %p - private or loopback", (entry) => {
    expect(reasonOf(entry)).toBeTruthy();
  });

  test("refuses a single-label name: it only resolves on a private network", () => {
    expect(reasonOf("intranet")).toContain("single-label");
  });

  test("refuses a wildcard over a bare TLD - that is not an allowlist", () => {
    expect(reasonOf("*.com")).toContain("too broad");
  });

  test("refuses a wildcard anywhere but the front", () => {
    expect(reasonOf("api.*.deepgram.com")).toBeTruthy();
    expect(reasonOf("*api.deepgram.com")).toBeTruthy();
  });

  test("refuses a wildcard on an IP address", () => {
    expect(reasonOf("*.203.0.113.7")).toBeTruthy();
  });

  test("refuses an empty entry and an over-long one", () => {
    expect(reasonOf("")).toBeTruthy();
    expect(reasonOf(`${"a".repeat(250)}.example.com`)).toContain("at most");
  });

  test("no refusal quotes anything but the entry it was given", () => {
    // The entry is user input echoed back; nothing else may join it.
    expect(reasonOf("https://api.deepgram.com")).toContain(
      "https://api.deepgram.com"
    );
  });
});

describe("parseAllowedHosts", () => {
  test("an empty list is refused: a secret with no hosts can never be used", () => {
    const parsed = parseAllowedHosts([]);
    expect(parsed.ok).toBe(false);
  });

  test(`caps the list at ${MAX_ALLOWED_HOSTS}`, () => {
    const many = Array.from(
      { length: MAX_ALLOWED_HOSTS + 1 },
      (_, index) => `h${index}.example.com`
    );
    const parsed = parseAllowedHosts(many);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.reason).toContain(String(MAX_ALLOWED_HOSTS));
  });

  test(`accepts exactly ${MAX_ALLOWED_HOSTS}`, () => {
    const many = Array.from(
      { length: MAX_ALLOWED_HOSTS },
      (_, index) => `h${index}.example.com`
    );
    expect(parseAllowedHosts(many).ok).toBe(true);
  });

  test("deduplicates after normalizing, so one host costs one slot", () => {
    const parsed = parseAllowedHosts([
      "api.deepgram.com",
      "API.DEEPGRAM.COM.",
      " api.deepgram.com ",
    ]);
    expect(parsed.ok && parsed.hosts).toEqual(["api.deepgram.com"]);
  });

  test("one bad entry refuses the whole list", () => {
    const parsed = parseAllowedHosts(["api.deepgram.com", "127.0.0.1"]);
    expect(parsed.ok).toBe(false);
  });
});

describe("isPrivateHost", () => {
  test.each([
    "localhost",
    "127.0.0.1",
    "10.0.0.5",
    "172.31.255.254",
    "192.168.1.1",
    "169.254.169.254",
    "100.100.0.1",
    "0.0.0.0",
    "db.internal",
    "printer.local",
    "SERVICE.LOCALHOST",
    "box.home.arpa",
  ])("%p is private", (hostname) => {
    expect(isPrivateHost(hostname)).toBe(true);
  });

  test.each([
    "api.deepgram.com",
    "203.0.113.7",
    "8.8.8.8",
    "172.32.0.1",
    "192.169.0.1",
    "100.128.0.1",
    "notlocalhost.com",
  ])("%p is public", (hostname) => {
    expect(isPrivateHost(hostname)).toBe(false);
  });
});

describe("hostMatches", () => {
  test("matches an exact host", () => {
    expect(hostMatches("api.deepgram.com", ["api.deepgram.com"])).toBe(true);
  });

  test("does not match a different host", () => {
    expect(hostMatches("api.openai.com", ["api.deepgram.com"])).toBe(false);
  });

  /**
   * The suffix trick, as two separate cases - they are different bugs and one
   * assertion must not stand for both.
   */
  test("an exact entry is not a suffix rule: evil-api.deepgram.com does not match api.deepgram.com", () => {
    expect(hostMatches("evil-api.deepgram.com", ["api.deepgram.com"])).toBe(
      false
    );
  });

  test("a wildcard matches on label boundaries, so evil-api.deepgram.com is genuinely under *.deepgram.com", () => {
    // Not a bug: the owner allowed every subdomain, and this is one.
    expect(hostMatches("evil-api.deepgram.com", ["*.deepgram.com"])).toBe(true);
  });

  test("a wildcard is not a substring rule either", () => {
    expect(hostMatches("deepgram.com.evil.test", ["*.deepgram.com"])).toBe(
      false
    );
    expect(hostMatches("notdeepgram.com", ["*.deepgram.com"])).toBe(false);
    expect(hostMatches("xdeepgram.com", ["*.deepgram.com"])).toBe(false);
  });

  test("*.deepgram.com does not match the apex - the owner adds it explicitly", () => {
    expect(hostMatches("deepgram.com", ["*.deepgram.com"])).toBe(false);
    expect(
      hostMatches("deepgram.com", ["*.deepgram.com", "deepgram.com"])
    ).toBe(true);
  });

  test("a wildcard spans more than one level", () => {
    expect(hostMatches("a.b.deepgram.com", ["*.deepgram.com"])).toBe(true);
  });

  test("matching is case-insensitive and tolerates a trailing dot", () => {
    expect(hostMatches("API.Deepgram.com.", ["api.deepgram.com"])).toBe(true);
  });

  test("an empty allowlist matches nothing", () => {
    expect(hostMatches("api.deepgram.com", [])).toBe(false);
  });

  test("an empty hostname matches nothing, wildcard or not", () => {
    expect(hostMatches("", ["*.deepgram.com"])).toBe(false);
    expect(hostMatches("   ", ["api.deepgram.com"])).toBe(false);
  });

  test("any one entry of the list is enough", () => {
    const allowed = ["api.openai.com", "*.deepgram.com"];
    expect(hostMatches("api.deepgram.com", allowed)).toBe(true);
    expect(hostMatches("api.openai.com", allowed)).toBe(true);
    expect(hostMatches("api.anthropic.com", allowed)).toBe(false);
  });
});
