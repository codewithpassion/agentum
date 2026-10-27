import { describe, expect, test } from "bun:test";
import {
  cutUserAgent,
  newSalt,
  referrerHost,
  truncateIp,
  utcDay,
  visitorHash,
} from "./view-privacy.ts";

const SALT = "daily-salt-not-a-real-secret";
const IP = "203.0.113.77";
const UA = "Mozilla/5.0 (X11; Linux x86_64)";
const HEX_64 = /^[0-9a-f]{64}$/;
const BASE64URL_22 = /^[A-Za-z0-9_-]{22}$/;

describe("truncateIp", () => {
  test("keeps the first three IPv4 octets as a /24", () => {
    expect(truncateIp("203.0.113.77")).toBe("203.0.113.0/24");
    expect(truncateIp("10.0.0.1")).toBe("10.0.0.0/24");
    expect(truncateIp("255.255.255.255")).toBe("255.255.255.0/24");
  });

  test("keeps the first three IPv6 groups as a /48", () => {
    expect(truncateIp("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48");
    expect(truncateIp("2001:0DB8:00AB:0001:0000:0000:0000:0002")).toBe(
      "2001:db8:ab::/48"
    );
  });

  test("expands :: at the start", () => {
    expect(truncateIp("::1")).toBe("0:0:0::/48");
    expect(truncateIp("::2:3:4:5:6:7")).toBe("0:0:2::/48");
  });

  test("expands :: in the middle", () => {
    expect(truncateIp("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(truncateIp("2001:db8:1::ab:cd")).toBe("2001:db8:1::/48");
  });

  test("expands :: at the end", () => {
    expect(truncateIp("2001:db8:aaaa:bbbb::")).toBe("2001:db8:aaaa::/48");
    expect(truncateIp("fe80::")).toBe("fe80:0:0::/48");
  });

  test("treats :: alone as all zeros", () => {
    expect(truncateIp("::")).toBe("0:0:0::/48");
  });

  test("accepts a dotted IPv4 tail on an IPv6 address", () => {
    expect(truncateIp("64:ff9b::198.51.100.7")).toBe("64:ff9b:0::/48");
  });

  test("treats an IPv4-mapped address as IPv4", () => {
    expect(truncateIp("::ffff:203.0.113.77")).toBe("203.0.113.0/24");
    expect(truncateIp("::FFFF:203.0.113.77")).toBe("203.0.113.0/24");
    expect(truncateIp("0:0:0:0:0:ffff:cb00:714d")).toBe("203.0.113.0/24");
  });

  test("returns null for invalid input", () => {
    const invalid = [
      "",
      "example.com",
      "localhost",
      "256.1.1.1",
      "1.2.3",
      "1.2.3.4.5",
      "1.2.3.-4",
      "1.2.3.4/24",
      "2001:db8::1::2",
      ":::",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "12345::1",
      "gggg::1",
      "2001:db8::1%eth0",
      "::1.2.3.256",
      "1.2.3.4::",
      "::ffff:999.0.0.1",
      " 203.0.113.77",
    ];
    for (const ip of invalid) {
      expect(truncateIp(ip)).toBeNull();
    }
  });

  test("never returns host bits", () => {
    expect(truncateIp("203.0.113.77")).not.toContain("77");
    expect(truncateIp("2001:db8:1234:5678:9abc:def0:1234:5678")).not.toContain(
      "5678"
    );
  });
});

describe("visitorHash", () => {
  test("is stable for the same inputs and 64 lower-case hex characters", async () => {
    const first = await visitorHash(SALT, IP, UA);
    const second = await visitorHash(SALT, IP, UA);
    expect(first).toBe(second);
    expect(first).toMatch(HEX_64);
  });

  test("changes with another salt, IP or user agent", async () => {
    const base = await visitorHash(SALT, IP, UA);
    expect(await visitorHash("another-salt", IP, UA)).not.toBe(base);
    expect(await visitorHash(SALT, "203.0.113.78", UA)).not.toBe(base);
    expect(await visitorHash(SALT, IP, "curl/8.0")).not.toBe(base);
  });

  test("never contains the IP text", async () => {
    const hash = await visitorHash(SALT, IP, UA);
    expect(hash).not.toContain(IP);
  });
});

describe("referrerHost", () => {
  test("keeps only the lower-case hostname", () => {
    expect(referrerHost("https://Example.COM/path/page?token=abc#frag")).toBe(
      "example.com"
    );
    expect(referrerHost("http://news.example.org:8080/a")).toBe(
      "news.example.org"
    );
    expect(referrerHost("https://user:pass@docs.example.net/x")).toBe(
      "docs.example.net"
    );
  });

  test("returns null for missing or empty referrers", () => {
    expect(referrerHost(null)).toBeNull();
    expect(referrerHost(undefined)).toBeNull();
    expect(referrerHost("")).toBeNull();
  });

  test("rejects non-http schemes and garbage", () => {
    expect(referrerHost("javascript:alert(1)")).toBeNull();
    expect(referrerHost("ftp://example.com/file")).toBeNull();
    expect(referrerHost("data:text/html,hi")).toBeNull();
    expect(referrerHost("not a url")).toBeNull();
    expect(referrerHost("http://")).toBeNull();
  });
});

describe("cutUserAgent", () => {
  test("trims and cuts to 256 characters", () => {
    const long = `  ${"a".repeat(300)}  `;
    const cut = cutUserAgent(long);
    expect(cut).toBe("a".repeat(256));
  });

  test("counts characters, not UTF-16 code units", () => {
    const cut = cutUserAgent("😀".repeat(300));
    expect(cut).toBe("😀".repeat(256));
  });

  test("keeps a short user agent as it is", () => {
    expect(cutUserAgent(`  ${UA}  `)).toBe(UA);
  });

  test("maps empty, blank and missing values to null", () => {
    expect(cutUserAgent("")).toBeNull();
    expect(cutUserAgent("   ")).toBeNull();
    expect(cutUserAgent(null)).toBeNull();
    expect(cutUserAgent(undefined)).toBeNull();
  });
});

describe("utcDay", () => {
  test("gives the UTC calendar day", () => {
    expect(utcDay(new Date("2026-10-27T00:00:00.000Z"))).toBe("2026-10-27");
    expect(utcDay(new Date("2026-10-27T23:59:59.999Z"))).toBe("2026-10-27");
  });

  test("does not roll over early for a zone ahead of UTC", () => {
    // 00:30 on 28 October in UTC+10 is still 27 October in UTC.
    expect(utcDay(new Date("2026-10-27T14:30:00.000Z"))).toBe("2026-10-27");
    expect(utcDay(new Date("2026-10-28T00:00:00.000Z"))).toBe("2026-10-28");
  });
});

describe("newSalt", () => {
  test("gives distinct base64url values of 16 bytes", () => {
    const salts = new Set(Array.from({ length: 50 }, () => newSalt()));
    expect(salts.size).toBe(50);
    for (const salt of salts) {
      expect(salt).toMatch(BASE64URL_22);
    }
  });
});
