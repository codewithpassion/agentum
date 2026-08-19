import { describe, expect, test } from "bun:test";
import {
  generateMcpToken,
  hashMcpToken,
  mcpUrlForToken,
  timingSafeEqual,
} from "./mcp-token";

const SHA256_HEX_LENGTH = 64;
const URL_SAFE = /^[\w-]+$/;
const TOKEN_LENGTH = 43;

describe("generateMcpToken", () => {
  test("returns 256 bits of URL-safe randomness", () => {
    const token = generateMcpToken();
    expect(token).toMatch(URL_SAFE);
    // 32 bytes, base64url, unpadded.
    expect(token).toHaveLength(TOKEN_LENGTH);
  });

  test("does not repeat", () => {
    const tokens = new Set(
      Array.from({ length: 100 }, () => generateMcpToken())
    );
    expect(tokens.size).toBe(100);
  });
});

describe("hashMcpToken", () => {
  test("is a stable SHA-256 hex digest", async () => {
    expect(await hashMcpToken("hello")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    );
  });

  test("differs per token and never returns the token", async () => {
    const token = generateMcpToken();
    const hash = await hashMcpToken(token);
    expect(hash).toHaveLength(SHA256_HEX_LENGTH);
    expect(hash).not.toContain(token);
    expect(hash).not.toBe(await hashMcpToken(generateMcpToken()));
  });

  test("verifies a token by comparing digests", async () => {
    const token = generateMcpToken();
    const stored = await hashMcpToken(token);
    expect(timingSafeEqual(stored, await hashMcpToken(token))).toBe(true);
    expect(timingSafeEqual(stored, await hashMcpToken(`${token}x`))).toBe(
      false
    );
  });
});

describe("timingSafeEqual", () => {
  test("rejects differing lengths and contents", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("", "")).toBe(true);
  });
});

describe("mcpUrlForToken", () => {
  test("prefers PUBLIC_APP_URL and trims trailing slashes", () => {
    expect(
      mcpUrlForToken("https://app.example.com/", "http://localhost:3000/x", "t")
    ).toBe("https://app.example.com/mcp/t");
  });

  test("falls back to the request origin", () => {
    expect(
      mcpUrlForToken(undefined, "http://localhost:3100/api/agents", "t")
    ).toBe("http://localhost:3100/mcp/t");
    expect(mcpUrlForToken("", "http://localhost:3100/api/agents", "t")).toBe(
      "http://localhost:3100/mcp/t"
    );
  });
});
