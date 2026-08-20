import { describe, expect, test } from "bun:test";
import { assertSafeUrl, canonicalizeConnectorUrl, isSafeUrl } from "./url";

const HTTPS_MESSAGE = /https/;
const INVALID_MESSAGE = /valid URL/;
const CREDENTIALS_MESSAGE = /credentials/;

describe("assertSafeUrl", () => {
  test("accepts a public https endpoint", () => {
    expect(assertSafeUrl("https://mcp.linear.app/mcp").hostname).toBe(
      "mcp.linear.app"
    );
  });

  test("accepts a public literal address", () => {
    expect(isSafeUrl("https://93.184.216.34/mcp")).toBe(true);
  });

  test.each([
    ["http://mcp.example.com/mcp", HTTPS_MESSAGE],
    ["ftp://mcp.example.com/mcp", HTTPS_MESSAGE],
    ["not-a-url", INVALID_MESSAGE],
    ["https://user:pass@mcp.example.com/mcp", CREDENTIALS_MESSAGE],
  ])("rejects %s", (raw, message) => {
    expect(() => assertSafeUrl(raw)).toThrow(message);
  });

  test.each([
    "https://localhost/mcp",
    "https://LOCALHOST/mcp",
    "https://app.localhost/mcp",
    "https://printer.local/mcp",
    "https://vault.internal/mcp",
    "https://box.home.arpa/mcp",
  ])("rejects the loopback or private name %s", (raw) => {
    expect(isSafeUrl(raw)).toBe(false);
  });

  test.each([
    "https://127.0.0.1/mcp",
    "https://127.1.2.3/mcp",
    "https://10.0.0.5/mcp",
    "https://172.16.0.1/mcp",
    "https://172.31.255.255/mcp",
    "https://192.168.1.1/mcp",
    "https://169.254.169.254/mcp",
    "https://100.64.0.1/mcp",
    "https://0.0.0.0/mcp",
    "https://224.0.0.1/mcp",
  ])("rejects the private address %s", (raw) => {
    expect(isSafeUrl(raw)).toBe(false);
  });

  test.each([
    "https://[::1]/mcp",
    "https://[::]/mcp",
    "https://[fd00::1]/mcp",
    "https://[fe80::1]/mcp",
    "https://[::ffff:127.0.0.1]/mcp",
  ])("rejects the private IPv6 address %s", (raw) => {
    expect(isSafeUrl(raw)).toBe(false);
  });

  test("allows a public IPv6 address", () => {
    expect(isSafeUrl("https://[2606:4700::1111]/mcp")).toBe(true);
  });

  test("172.32 is public - the private block stops at 172.31", () => {
    expect(isSafeUrl("https://172.32.0.1/mcp")).toBe(true);
  });

  // The e2e escape hatch is compiled in only by `vite --mode e2e`, so outside
  // that one build it must be indistinguishable from not existing.
  test.each([
    "http://127.0.0.1:3111/mcp",
    "http://127.0.0.1/mcp",
    "https://127.0.0.1:3111/mcp",
  ])("rejects the loopback stub address %s outside e2e mode", (raw) => {
    expect(isSafeUrl(raw)).toBe(false);
  });
});

describe("canonicalizeConnectorUrl", () => {
  test("drops the fragment and an empty query", () => {
    expect(canonicalizeConnectorUrl("https://mcp.example.com/mcp?#frag")).toBe(
      "https://mcp.example.com/mcp"
    );
  });

  test("keeps a meaningful query", () => {
    expect(canonicalizeConnectorUrl("https://mcp.example.com/mcp?v=2")).toBe(
      "https://mcp.example.com/mcp?v=2"
    );
  });

  test("normalizes the host casing, so two spellings collide on one row", () => {
    expect(canonicalizeConnectorUrl("https://MCP.Example.com/mcp")).toBe(
      "https://mcp.example.com/mcp"
    );
  });

  test("rejects an unsafe URL rather than storing it", () => {
    expect(() => canonicalizeConnectorUrl("https://10.0.0.1/mcp")).toThrow();
  });
});
