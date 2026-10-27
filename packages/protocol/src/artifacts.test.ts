import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_RESERVED_PREFIX,
  artifactContentPath,
  artifactManifestSchema,
  contentTypeForPath,
  isReservedArtifactPath,
  parseArtifactContentPath,
  parseBridgeMessage,
  viewTokenClaimsSchema,
} from "./artifacts.ts";

const ID = "3f2b8c1e-5d4a-4b7e-9c3a-1a2b3c4d5e6f";
const HASH = "a".repeat(64);
const rpc = { jsonrpc: "2.0" as const };

describe("bridge messages", () => {
  const valid: unknown[] = [
    {
      ...rpc,
      id: 1,
      method: "ui/initialize",
      params: {
        appCapabilities: {},
        appInfo: { name: "a", version: "1" },
        nonce: "abc123",
        protocolVersion: "2026-01-26",
      },
    },
    { ...rpc, method: "ui/notifications/initialized" },
    {
      ...rpc,
      method: "ui/notifications/size-changed",
      params: { height: 400, width: 300 },
    },
    {
      ...rpc,
      id: "a",
      method: "ui/open-link",
      params: { url: "https://example.com/x" },
    },
    {
      ...rpc,
      id: 2,
      method: "ui/message",
      params: { content: [{ text: "hi", type: "text" }], role: "user" },
    },
    {
      ...rpc,
      id: 3,
      method: "tools/call",
      params: { arguments: { q: 1 }, name: "t" },
    },
    {
      ...rpc,
      id: 4,
      method: "storage/get",
      params: { key: "k", scope: "viewer" },
    },
    {
      ...rpc,
      id: 5,
      method: "storage/set",
      params: { key: "k", scope: "shared", value: { a: [1] } },
    },
    {
      ...rpc,
      id: 6,
      method: "storage/delete",
      params: { key: "k", scope: "shared" },
    },
    {
      ...rpc,
      id: 7,
      method: "storage/list",
      params: { prefix: "p", scope: "viewer" },
    },
  ];

  test("parses every valid message", () => {
    for (const message of valid) {
      expect(parseBridgeMessage(message)).toEqual(message as never);
    }
  });

  test("rejects a wrong jsonrpc version", () => {
    for (const message of valid) {
      expect(
        parseBridgeMessage({ ...(message as object), jsonrpc: "1.0" })
      ).toBeNull();
    }
  });

  test("rejects a request without id, but accepts the notification without one", () => {
    for (const message of valid) {
      const { id, ...rest } = message as { id?: unknown; method: string };
      const isNotification = rest.method.startsWith("ui/notifications/");
      expect(parseBridgeMessage(rest) !== null).toBe(isNotification);
    }
  });

  test("rejects an id on a notification", () => {
    expect(
      parseBridgeMessage({
        ...rpc,
        id: 1,
        method: "ui/notifications/size-changed",
        params: {},
      })
    ).toBeNull();
  });

  test("rejects an extra field", () => {
    for (const message of valid) {
      expect(
        parseBridgeMessage({ ...(message as object), extra: 1 })
      ).toBeNull();
      const { params } = message as { params: object };
      expect(
        parseBridgeMessage({
          ...(message as object),
          params: { ...params, extra: 1 },
        })
      ).toBeNull();
    }
  });

  test("rejects an unknown method", () => {
    expect(
      parseBridgeMessage({ ...rpc, id: 1, method: "ui/nope", params: {} })
    ).toBeNull();
    expect(parseBridgeMessage(null)).toBeNull();
    expect(parseBridgeMessage("x")).toBeNull();
  });

  test("rejects a bad storage scope", () => {
    for (const method of ["storage/get", "storage/delete", "storage/list"]) {
      expect(
        parseBridgeMessage({
          ...rpc,
          id: 1,
          method,
          params: { key: "k", scope: "global" },
        })
      ).toBeNull();
    }
    expect(
      parseBridgeMessage({
        ...rpc,
        id: 1,
        method: "storage/set",
        params: { key: "k", scope: "x", value: 1 },
      })
    ).toBeNull();
  });

  test("rejects links that are not http or https", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://x.com",
      "nope",
    ]) {
      expect(
        parseBridgeMessage({
          ...rpc,
          id: 1,
          method: "ui/open-link",
          params: { url },
        })
      ).toBeNull();
    }
    expect(
      parseBridgeMessage({
        ...rpc,
        id: 1,
        method: "ui/open-link",
        params: { url: "http://example.com" },
      })
    ).not.toBeNull();
  });

  test("rejects a ui/message with a non-user role or non-text content", () => {
    expect(
      parseBridgeMessage({
        ...rpc,
        id: 1,
        method: "ui/message",
        params: { content: [{ text: "x", type: "text" }], role: "assistant" },
      })
    ).toBeNull();
    expect(
      parseBridgeMessage({
        ...rpc,
        id: 1,
        method: "ui/message",
        params: { content: [{ type: "image" }], role: "user" },
      })
    ).toBeNull();
  });
});

describe("manifest", () => {
  const file = { contentType: "text/html", sha256: HASH, size: 10 };
  const manifest = { entry: "index.html", files: { "index.html": file } };

  test("accepts a valid manifest", () => {
    expect(artifactManifestSchema.safeParse(manifest).success).toBe(true);
    expect(
      artifactManifestSchema.safeParse({
        entry: "index.html",
        files: { "a/b.js": file, "index.html": file },
      }).success
    ).toBe(true);
  });

  test("rejects a missing entry file", () => {
    expect(
      artifactManifestSchema.safeParse({
        entry: "main.html",
        files: { "index.html": file },
      }).success
    ).toBe(false);
  });

  test("rejects bad paths", () => {
    for (const path of [
      "../x.js",
      "a/../x.js",
      "/x.js",
      "a//b.js",
      "./x.js",
      "a\\b.js",
      "",
      "_hm/x.js",
      "_hm",
    ]) {
      expect(
        artifactManifestSchema.safeParse({
          entry: "index.html",
          files: { "index.html": file, [path]: file },
        }).success
      ).toBe(false);
    }
  });

  test("rejects a bad hash, size and extra field", () => {
    for (const bad of [
      { ...file, sha256: "A".repeat(64) },
      { ...file, sha256: "a".repeat(63) },
      { ...file, size: -1 },
      { ...file, extra: 1 },
    ]) {
      expect(
        artifactManifestSchema.safeParse({
          entry: "index.html",
          files: { "index.html": bad },
        }).success
      ).toBe(false);
    }
  });

  test("reserved path check", () => {
    expect(ARTIFACT_RESERVED_PREFIX).toBe("_hm/");
    expect(isReservedArtifactPath("_hm/bridge.js")).toBe(true);
    expect(isReservedArtifactPath("a/_hm/x.js")).toBe(false);
    expect(isReservedArtifactPath("_hmx/x.js")).toBe(false);
  });
});

describe("view token claims", () => {
  const claims = {
    artifactId: ID,
    expiresAt: 1_800_000_000,
    shareId: "s1",
    versionId: "v1",
    viewer: "link",
    workspaceId: "w1",
  };

  test("accepts valid claims", () => {
    expect(viewTokenClaimsSchema.safeParse(claims).success).toBe(true);
    expect(
      viewTokenClaimsSchema.safeParse({
        ...claims,
        shareId: undefined,
        userId: "u1",
        viewer: "member",
      }).success
    ).toBe(true);
  });

  test("rejects bad claims", () => {
    const { versionId, ...missing } = claims;
    expect(viewTokenClaimsSchema.safeParse(missing).success).toBe(false);
    expect(
      viewTokenClaimsSchema.safeParse({ ...claims, artifactId: "nope" }).success
    ).toBe(false);
    expect(
      viewTokenClaimsSchema.safeParse({ ...claims, viewer: "admin" }).success
    ).toBe(false);
    expect(
      viewTokenClaimsSchema.safeParse({ ...claims, extra: 1 }).success
    ).toBe(false);
    expect(
      viewTokenClaimsSchema.safeParse({ ...claims, expiresAt: 0 }).success
    ).toBe(false);
    expect(
      viewTokenClaimsSchema.safeParse({ ...claims, expiresAt: -5 }).success
    ).toBe(false);
  });
});

describe("content path", () => {
  test("builds the documented shape", () => {
    expect(artifactContentPath({ artifactId: ID, token: "hm_view_abc" })).toBe(
      `/a/${ID}/c/hm_view_abc/`
    );
    expect(
      artifactContentPath({ artifactId: ID, path: "css/app.css", token: "t" })
    ).toBe(`/a/${ID}/c/t/css/app.css`);
  });

  test("round trips plain, spaced and unicode paths", () => {
    for (const path of [
      "",
      "index.html",
      "my dir/a file.js",
      "größe/日本語 ✓.png",
      "a#b/c?d%e.txt",
    ]) {
      const built = artifactContentPath({
        artifactId: ID,
        path,
        token: "hm_view_a.b-c_d",
      });
      expect(parseArtifactContentPath(built)).toEqual({
        artifactId: ID,
        path,
        token: "hm_view_a.b-c_d",
      });
    }
    expect(
      artifactContentPath({ artifactId: ID, path: "my dir/a b.js", token: "t" })
    ).toBe(`/a/${ID}/c/t/my%20dir/a%20b.js`);
  });

  test("rejects paths that do not fit", () => {
    expect(parseArtifactContentPath("/a/nope/c/t/x")).toBeNull();
    expect(parseArtifactContentPath(`/a/${ID}/c//x`)).toBeNull();
    expect(parseArtifactContentPath(`/a/${ID}/c/t`)).toBeNull();
    expect(parseArtifactContentPath(`/a/${ID}/x/t/x`)).toBeNull();
    expect(parseArtifactContentPath(`/a/${ID}/c/t/../x`)).toBeNull();
    expect(parseArtifactContentPath(`/a/${ID}/c/t/%2e%2e/x`)).toBeNull();
    expect(parseArtifactContentPath(`/a/${ID}/c/t/a%2F..%2Fb`)).toBeNull();
    expect(parseArtifactContentPath(`/a/${ID}/c/t/%E0%A4%A`)).toBeNull();
  });
});

describe("content types", () => {
  test("maps known, upper-case, unknown and missing extensions", () => {
    expect(contentTypeForPath("index.html")).toContain("text/html");
    expect(contentTypeForPath("a/b/app.mjs")).toContain("text/javascript");
    expect(contentTypeForPath("a/LOGO.PNG")).toBe("image/png");
    expect(contentTypeForPath("x.unknown")).toBe("application/octet-stream");
    expect(contentTypeForPath("Makefile")).toBe("application/octet-stream");
    expect(contentTypeForPath("dir.v2/Makefile")).toBe(
      "application/octet-stream"
    );
    expect(contentTypeForPath("x.constructor")).toBe(
      "application/octet-stream"
    );
  });
});
