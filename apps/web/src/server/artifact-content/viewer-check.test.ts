import { describe, expect, it } from "bun:test";
import type { ViewTokenClaims } from "@repo/protocol/artifacts";
import {
  type ViewerCheckPorts,
  viewerPorts,
  viewerStillAllowed,
} from "./viewer-check.ts";

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

  it("asks membership for a proposed version's test token that names a person", async () => {
    const claims = { ...base, userId: "user_1", viewer: "test" as const };
    expect(
      await viewerStillAllowed(
        claims,
        ports({ isMember: () => Promise.resolve(false) })
      )
    ).toBe(false);
  });

  it("leaves a test token with no person alone", async () => {
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

describe("viewerPorts", () => {
  const services = (shareOk: boolean, member: boolean, calls: string[]) => ({
    services: {
      artifactApp: {
        memberPrincipal: (userId: string, workspaceId: string) => {
          calls.push(`member:${userId}:${workspaceId}`);
          return Promise.resolve(member ? { userId } : null);
        },
      },
      artifactShares: {
        shareState: (shareId: string, artifactId: string) => {
          calls.push(`share:${shareId}:${artifactId}`);
          return Promise.resolve({ ok: shareOk });
        },
      },
    },
  });

  it("reads the share state on every call, with no cache", async () => {
    const calls: string[] = [];
    const live = viewerPorts(services(true, true, calls));
    await live.isShareLive("share_r", "art_1");
    await live.isShareLive("share_r", "art_1");
    expect(calls).toEqual(["share:share_r:art_1", "share:share_r:art_1"]);
    expect(
      await viewerPorts(services(false, true, calls)).isShareLive(
        "share_r",
        "art_1"
      )
    ).toBe(false);
  });

  it("keeps a yes for a minute, then asks again, and never keeps a no", async () => {
    const calls: string[] = [];
    let clock = 1000;
    const yes = viewerPorts(services(true, true, calls), () => clock);
    expect(await yes.isMember("user_k", "ws_1")).toBe(true);
    expect(await yes.isMember("user_k", "ws_1")).toBe(true);
    expect(calls).toHaveLength(1);
    clock += 61_000;
    const gone = viewerPorts(services(true, false, calls), () => clock);
    expect(await gone.isMember("user_k", "ws_1")).toBe(false);
    expect(await gone.isMember("user_k", "ws_1")).toBe(false);
    expect(calls).toHaveLength(3);
  });
});
