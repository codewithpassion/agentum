import { describe, expect, test } from "bun:test";
import { bearerToken, hashToken, isAuthorized, timingSafeEqual } from "./token";

describe("hashToken", () => {
  test("is the SHA-256 hex digest Agentum stores", async () => {
    // The value `hashMcpToken` in apps/web produces for the same input; the two
    // sides must agree or no daemon can ever authenticate.
    expect(await hashToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("timingSafeEqual", () => {
  test("compares equal and unequal digests", () => {
    expect(timingSafeEqual("abcd", "abcd")).toBe(true);
    expect(timingSafeEqual("abcd", "abce")).toBe(false);
    expect(timingSafeEqual("abcd", "abcde")).toBe(false);
  });
});

describe("bearerToken", () => {
  test("reads the token out of the header", () => {
    expect(bearerToken("Bearer secret")).toBe("secret");
    expect(bearerToken("bearer   secret")).toBe("secret");
  });

  test("refuses anything else", () => {
    expect(bearerToken(null)).toBeNull();
    expect(bearerToken("Basic secret")).toBeNull();
    expect(bearerToken("Bearer ")).toBeNull();
  });
});

describe("isAuthorized", () => {
  test("accepts the token behind the hash and nothing else", async () => {
    const hash = await hashToken("right");
    expect(await isAuthorized("Bearer right", hash)).toBe(true);
    expect(await isAuthorized("Bearer wrong", hash)).toBe(false);
    expect(await isAuthorized(null, hash)).toBe(false);
  });
});
