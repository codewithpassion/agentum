import { describe, expect, test } from "bun:test";
import { ForbiddenError } from "./authz.ts";
import type { UserPrincipal } from "./guards.ts";
import {
  effectiveOwner,
  readableWorkspace,
  requireSession,
  requireUser,
} from "./guards.ts";
import type { Principal } from "./workspaces.ts";

const user = (via: UserPrincipal["via"]): UserPrincipal => ({
  kind: "user",
  userId: "u1",
  via,
  workspaceId: "w1",
});
const system = { kind: "system" } as Principal;
const key = { kind: "key", workspaceId: "w1" } as unknown as Principal;

describe("requireUser", () => {
  test("admits a person on any route in", () => {
    for (const via of ["session", "api_key", "oauth", "slack"] as const) {
      const p = user(via);
      expect(requireUser(p, "x")).toBe(p);
    }
  });

  test("refuses everything that is not a person", () => {
    expect(() => requireUser(system, "x.y")).toThrow(ForbiddenError);
    expect(() => requireUser(key, "x.y")).toThrow("Not allowed: x.y");
  });
});

describe("requireSession", () => {
  test("admits only a browser session", () => {
    const p = user("session");
    expect(requireSession(p, "x")).toBe(p);
    for (const via of ["api_key", "oauth", "slack"] as const) {
      expect(() => requireSession(user(via), "x")).toThrow(ForbiddenError);
    }
    expect(() => requireSession(system, "x")).toThrow(ForbiddenError);
  });
});

describe("readableWorkspace", () => {
  test("returns the workspace of a non-system principal", () => {
    expect(readableWorkspace(user("session"), "x")).toBe("w1");
    expect(readableWorkspace(key, "x")).toBe("w1");
  });

  test("refuses the system principal", () => {
    expect(() => readableWorkspace(system, "x")).toThrow(ForbiddenError);
  });
});

describe("effectiveOwner", () => {
  test("falls back to the creator", () => {
    expect(effectiveOwner({ createdBy: "a", ownerUserId: null })).toBe("a");
    expect(effectiveOwner({ createdBy: "a", ownerUserId: "b" })).toBe("b");
  });
});
