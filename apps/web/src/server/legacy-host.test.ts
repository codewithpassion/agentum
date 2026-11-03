import { describe, expect, test } from "bun:test";
import { type LegacyRequest, legacyRedirect } from "./legacy-host.ts";

const LEGACY = "harbourmaster.rockyshoreslabs.io, old.example.com";
const BASE = "https://agentumbot.io";

const page = (url: string, extra: Partial<LegacyRequest> = {}) => ({
  accept: "text/html,application/xhtml+xml",
  method: "GET",
  upgrade: null,
  url,
  ...extra,
});

describe("legacyRedirect", () => {
  test("a page load on a legacy host moves to the same path and query", () => {
    expect(
      legacyRedirect(
        page("https://harbourmaster.rockyshoreslabs.io/s/tok?x=1"),
        LEGACY,
        BASE
      )
    ).toBe("https://agentumbot.io/s/tok?x=1");
    expect(
      legacyRedirect(page("https://OLD.example.com/desk"), LEGACY, BASE)
    ).toBe("https://agentumbot.io/desk");
  });

  test("API calls, posts, sockets and non-HTML gets are served in place", () => {
    const host = "https://harbourmaster.rockyshoreslabs.io";
    for (const request of [
      page(`${host}/mcp`, { accept: "application/json, text/event-stream" }),
      page(`${host}/a2a/x`, { method: "POST" }),
      page(`${host}/api/machines/connect`, { upgrade: "websocket" }),
      page(`${host}/install.sh`, { accept: "*/*" }),
      page(`${host}/desk`, { accept: null }),
    ]) {
      expect(legacyRedirect(request, LEGACY, BASE)).toBeNull();
    }
  });

  test("the new host, an unlisted host and an empty list never redirect", () => {
    expect(legacyRedirect(page(`${BASE}/desk`), LEGACY, BASE)).toBeNull();
    expect(
      legacyRedirect(page("https://other.example.com/"), LEGACY, BASE)
    ).toBeNull();
    expect(
      legacyRedirect(
        page("https://harbourmaster.rockyshoreslabs.io/"),
        "",
        BASE
      )
    ).toBeNull();
    expect(
      legacyRedirect(
        page("https://harbourmaster.rockyshoreslabs.io/"),
        LEGACY,
        undefined
      )
    ).toBeNull();
  });
});
