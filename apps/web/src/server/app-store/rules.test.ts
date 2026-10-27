import { describe, expect, test } from "bun:test";
import { canWrite, viewerKey } from "./rules.ts";
import type { AppViewer } from "./types.ts";

const member: AppViewer = { kind: "member", userId: "user_1" };
const snapshot: AppViewer = {
  dataMode: "snapshot",
  kind: "link",
  shareId: "share_1",
};
const live: AppViewer = { dataMode: "live", kind: "link", shareId: "share_1" };

describe("canWrite", () => {
  test("a member writes the viewer area", () => {
    expect(canWrite(member, "viewer")).toBe(true);
  });

  test("a member writes the shared area", () => {
    expect(canWrite(member, "shared")).toBe(true);
  });

  test("a snapshot link viewer writes neither area", () => {
    expect(canWrite(snapshot, "viewer")).toBe(false);
    expect(canWrite(snapshot, "shared")).toBe(false);
  });

  test("a live link viewer writes the viewer area", () => {
    expect(canWrite(live, "viewer")).toBe(true);
  });

  test("a live link viewer cannot write the shared area", () => {
    expect(canWrite(live, "shared")).toBe(false);
  });
});

describe("viewerKey", () => {
  test("a member gets a u: key from the user id", () => {
    expect(viewerKey(member)).toBe("u:user_1");
  });

  test("a link viewer gets an l: key from the share id", () => {
    expect(viewerKey(live)).toBe("l:share_1");
    expect(viewerKey(snapshot)).toBe("l:share_1");
  });
});
