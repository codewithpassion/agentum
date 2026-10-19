import { describe, expect, test } from "bun:test";
import {
  checkTarget,
  ownHostsOf,
  redirectTarget,
  type TargetCheck,
} from "./guard.ts";

const OWN = ["app.example.com"];

function refused(check: TargetCheck): boolean {
  return !check.ok;
}

describe("checkTarget allows public URLs", () => {
  test("https and http to a public host", () => {
    expect(checkTarget("https://example.com/a", OWN).ok).toBe(true);
    expect(checkTarget("http://example.com/a", OWN).ok).toBe(true);
  });

  test("keeps the http scheme on the returned URL", () => {
    const check = checkTarget("http://example.com/a", OWN);
    expect(check.ok && check.url.protocol).toBe("http:");
  });
});

describe("checkTarget refuses schemes", () => {
  for (const raw of [
    "ftp://example.com/file",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/plain,hi",
    "not a url",
  ]) {
    test(raw, () => {
      expect(refused(checkTarget(raw, OWN))).toBe(true);
    });
  }
});

describe("checkTarget refuses URL credentials", () => {
  test("user and password", () => {
    expect(refused(checkTarget("https://user:pass@example.com/", OWN))).toBe(
      true
    );
  });

  test("user only", () => {
    expect(refused(checkTarget("http://user@example.com/", OWN))).toBe(true);
  });
});

describe("checkTarget refuses internal addresses", () => {
  for (const raw of [
    "http://127.0.0.1/",
    "http://localhost/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://10.0.0.1/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://169.254.169.254/latest/meta-data/",
    "http://100.64.0.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://127.1/",
    "http://foo.internal/",
    "http://foo.local/",
    "http://intranet/",
    "https://localhost./",
    "https://169.254.169.254./",
  ]) {
    test(raw, () => {
      expect(refused(checkTarget(raw, OWN))).toBe(true);
    });
  }
});

describe("checkTarget refuses this Worker", () => {
  test("the own host, in upper case", () => {
    expect(refused(checkTarget("https://APP.example.com/", OWN))).toBe(true);
  });

  test("the own host with a trailing dot", () => {
    expect(refused(checkTarget("https://app.example.com./", OWN))).toBe(true);
  });

  test("the own host with a port", () => {
    expect(refused(checkTarget("https://app.example.com:8443/", OWN))).toBe(
      true
    );
  });

  test("the own host over http", () => {
    expect(refused(checkTarget("http://app.example.com/", OWN))).toBe(true);
  });

  test("another host is not refused by the own-host check", () => {
    expect(checkTarget("https://other.example.com/", OWN).ok).toBe(true);
  });
});

describe("ownHostsOf", () => {
  test("a missing base URL adds nothing", () => {
    expect(ownHostsOf(undefined)).toEqual([]);
  });

  test("a malformed base URL adds nothing", () => {
    expect(ownHostsOf("not a url")).toEqual([]);
  });

  test("a valid base URL gives its lower-case host without port or dot", () => {
    expect(ownHostsOf("https://App.Example.com:8443/")).toEqual([
      "app.example.com",
    ]);
    expect(ownHostsOf("https://app.example.com./")).toEqual([
      "app.example.com",
    ]);
  });

  test("extra names are normalised and de-duplicated", () => {
    expect(
      ownHostsOf("https://app.example.com", [
        "Other.Example.com:9000",
        "app.example.com",
      ])
    ).toEqual(["app.example.com", "other.example.com"]);
  });
});

describe("redirectTarget", () => {
  const from = new URL("https://example.com/start/page");

  test("a relative Location resolves against the sender", () => {
    const check = redirectTarget(from, "/next", OWN);
    expect(check.ok && check.url.href).toBe("https://example.com/next");
  });

  test("a protocol-relative Location to an internal host is refused", () => {
    expect(refused(redirectTarget(from, "//127.0.0.1/admin", OWN))).toBe(true);
  });

  test("an absolute Location to a metadata address is refused", () => {
    expect(
      refused(
        redirectTarget(from, "http://169.254.169.254/latest/meta-data/", OWN)
      )
    ).toBe(true);
  });

  test("a Location to the own host is refused", () => {
    expect(refused(redirectTarget(from, "https://app.example.com/", OWN))).toBe(
      true
    );
  });

  test("a good Location is allowed", () => {
    const check = redirectTarget(from, "https://docs.example.org/x", OWN);
    expect(check.ok && check.url.href).toBe("https://docs.example.org/x");
  });

  test("a missing or empty Location is refused", () => {
    expect(refused(redirectTarget(from, null, OWN))).toBe(true);
    expect(refused(redirectTarget(from, "", OWN))).toBe(true);
    expect(refused(redirectTarget(from, "   ", OWN))).toBe(true);
  });

  test("a Location that does not parse is refused", () => {
    expect(refused(redirectTarget(from, "http://[bad", OWN))).toBe(true);
  });
});
