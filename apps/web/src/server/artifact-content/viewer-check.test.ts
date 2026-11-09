import { describe, expect, it } from "bun:test";
import type { ViewTokenClaims } from "@repo/protocol/artifacts";
import { type ViewerCheckPorts, viewerStillAllowed } from "./viewer-check.ts";

const base: ViewTokenClaims = {
  artifactId: "6f1c2f0e-8f0e-4c3a-9f37-2b3f3c1d9a10",
  expiresAt: 1,
  versionId: "ver_1",
  viewer: "member",
  workspaceId: "ws_1",
};

const ports = (over: Partial<ViewerCheckPorts> = {}): ViewerCheckPorts => ({
  isMember: () => Promise.resolve(true),
  isShareLive: () => Promise.resolve(true),
  ...over,
});

describe("viewerStillAllowed", () => {
  it("asks the share for a link token and follows its answer", async () => {
    const claims = { ...base, shareId: "share_1", viewer: "link" as const };
    expect(await viewerStillAllowed(claims, ports())).toBe(true);
    expect(
      await viewerStillAllowed(
        claims,
        ports({ isShareLive: () => Promise.resolve(false) })
      )
    ).toBe(false);
  });

  it("asks membership for a member token", async () => {
    const claims = { ...base, userId: "user_1" };
    expect(await viewerStillAllowed(claims, ports())).toBe(true);
    expect(
      await viewerStillAllowed(
        claims,
        ports({ isMember: () => Promise.resolve(false) })
      )
    ).toBe(false);
  });

  it("leaves a test token alone", async () => {
    const claims = { ...base, viewer: "test" as const };
    expect(
      await viewerStillAllowed(
        claims,
        ports({
          isMember: () => Promise.resolve(false),
          isShareLive: () => Promise.resolve(false),
        })
      )
    ).toBe(true);
  });
});
