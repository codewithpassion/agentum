import { describe, expect, test } from "bun:test";
import type { ArtifactTestResult } from "./driver.ts";
import { formatArtifactTestResult, MAX_RESULT_BYTES } from "./format.ts";

const base = (
  overrides: Partial<ArtifactTestResult> = {}
): ArtifactTestResult => ({
  badResponses: [],
  consoleEntries: [],
  failedRequests: [],
  screenshot: new Uint8Array(),
  snapshot: {
    links: [],
    linksTruncated: false,
    text: "Hello world",
    textTruncated: false,
    title: "Report",
    url: "https://app.test/a/1/c/hm_view_abcdefghijklmnop.sig/index.html",
  },
  title: "Report",
  viewport: "desktop",
  ...overrides,
});

describe("formatArtifactTestResult", () => {
  test("a clean page says so section by section", () => {
    const text = formatArtifactTestResult(base());
    expect(text).toContain("Artifact test at desktop (1280x800)");
    expect(text).toContain("Title: Report");
    expect(text).toContain("Load: ok");
    expect(text).toContain("Console errors and warnings: none");
    expect(text).toContain("Failed requests: none");
    expect(text).toContain("Responses with status 400 or higher: none");
    expect(text).toContain("Hello world");
  });

  test("lists console entries, failures and bad responses", () => {
    const text = formatArtifactTestResult(
      base({
        badResponses: [{ status: 404, url: "https://app.test/missing.css" }],
        consoleEntries: [
          { level: "error", text: "Refused to load the script because CSP" },
          { level: "warning", text: "deprecated" },
        ],
        failedRequests: [
          {
            method: "GET",
            reason: "net::ERR_BLOCKED_BY_CSP",
            url: "https://cdn.test/x.js",
          },
        ],
        loadError: "Timeout 30000ms exceeded",
        viewport: "phone",
      })
    );
    expect(text).toContain("(390x844)");
    expect(text).toContain("Load: FAILED, Timeout 30000ms exceeded");
    expect(text).toContain("Console errors and warnings (2):");
    expect(text).toContain("- [error] Refused to load the script because CSP");
    expect(text).toContain("- [warning] deprecated");
    expect(text).toContain(
      "- GET https://cdn.test/x.js: net::ERR_BLOCKED_BY_CSP"
    );
    expect(text).toContain("- 404 https://app.test/missing.css");
  });

  test("never prints a view token", () => {
    const token = "hm_view_abcdefghijklmnop.signaturepart";
    const text = formatArtifactTestResult(
      base({
        badResponses: [
          { status: 404, url: `https://app.test/a/1/c/${token}/x.css` },
        ],
        consoleEntries: [{ level: "error", text: `failed ${token}` }],
      })
    );
    expect(text).not.toContain("hm_view_");
    expect(text).toContain("[redacted]");
  });

  test("caps each list and long entries", () => {
    const consoleEntries = Array.from({ length: 50 }, (_, index) => ({
      level: "error" as const,
      text: `error ${index} ${"x".repeat(1000)}`,
    }));
    const text = formatArtifactTestResult(base({ consoleEntries }));
    expect(text).toContain("Console errors and warnings (50):");
    expect(text).toContain("- ... and 30 more");
    expect(text).not.toContain("x".repeat(400));
    expect(text).not.toContain("error 25");
  });

  test("caps the whole result in bytes without splitting a code point", () => {
    const text = formatArtifactTestResult(
      base({
        snapshot: {
          links: [],
          linksTruncated: false,
          text: "é".repeat(30_000),
          textTruncated: true,
          title: "Report",
          url: "https://app.test/",
        },
      })
    );
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      MAX_RESULT_BYTES
    );
    expect(text.endsWith("[result truncated]")).toBe(true);
    expect(text).not.toContain("�");
    expect(text).toContain("Console errors and warnings: none");
  });

  test("lists at most a handful of links", () => {
    const links = Array.from({ length: 40 }, (_, index) => ({
      href: `https://example.com/${index}`,
      text: `Link ${index}`,
    }));
    const text = formatArtifactTestResult(
      base({ snapshot: { ...base().snapshot, links } })
    );
    expect(text).toContain("Links (40):");
    expect(text).toContain("Link 19 ->");
    expect(text).not.toContain("Link 20 ->");
  });
});
