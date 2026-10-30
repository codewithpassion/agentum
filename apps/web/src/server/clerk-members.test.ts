import { describe, expect, test } from "bun:test";
import type { WorkspaceMember } from "@repo/db/shared";
import type { MemberLister } from "@repo/services/members";
import {
  type ClerkMembershipSource,
  cachedMembers,
  toWorkspaceMember,
} from "./clerk-members.ts";

const membership = (
  publicUserData: ClerkMembershipSource["publicUserData"]
): ClerkMembershipSource => ({ publicUserData });

const publicUser = (
  overrides: Partial<NonNullable<ClerkMembershipSource["publicUserData"]>> = {}
): NonNullable<ClerkMembershipSource["publicUserData"]> => ({
  firstName: "Ada",
  identifier: "ada@example.com",
  lastName: "Lovelace",
  userId: "user_1",
  ...overrides,
});

describe("toWorkspaceMember", () => {
  test("joins first and last name", () => {
    expect(toWorkspaceMember(membership(publicUser()))).toEqual({
      name: "Ada Lovelace",
      userId: "user_1",
    });
  });

  test("uses the first name alone when there is no last name", () => {
    expect(
      toWorkspaceMember(membership(publicUser({ lastName: null })))
    ).toEqual({ name: "Ada", userId: "user_1" });
  });

  test("falls back to the identifier when both names are blank", () => {
    expect(
      toWorkspaceMember(
        membership(publicUser({ firstName: "  ", lastName: null }))
      )
    ).toEqual({ name: "ada@example.com", userId: "user_1" });
  });

  test("gives a null when there is no public user data", () => {
    expect(toWorkspaceMember(membership(null))).toBeNull();
    expect(toWorkspaceMember({})).toBeNull();
  });
});

describe("cachedMembers", () => {
  const member = (clerkOrgId: string): WorkspaceMember[] => [
    { name: clerkOrgId, userId: `user_${clerkOrgId}` },
  ];

  test("does not call the lister again within the ttl", async () => {
    const calls: string[] = [];
    const list: MemberLister = (clerkOrgId) => {
      calls.push(clerkOrgId);
      return Promise.resolve(member(clerkOrgId));
    };
    let clock = 1000;
    const cached = cachedMembers(list, { now: () => clock, ttlMs: 500 });

    expect(await cached("org_a")).toEqual(member("org_a"));
    clock += 499;
    expect(await cached("org_a")).toEqual(member("org_a"));
    expect(calls).toEqual(["org_a"]);
  });

  test("calls the lister again after the ttl", async () => {
    const calls: string[] = [];
    const list: MemberLister = (clerkOrgId) => {
      calls.push(clerkOrgId);
      return Promise.resolve(member(clerkOrgId));
    };
    let clock = 1000;
    const cached = cachedMembers(list, { now: () => clock, ttlMs: 500 });

    await cached("org_a");
    clock += 500;
    await cached("org_a");
    expect(calls).toEqual(["org_a", "org_a"]);
  });

  test("uses the default ttl of 60 seconds", async () => {
    let calls = 0;
    const list: MemberLister = () => {
      calls += 1;
      return Promise.resolve([]);
    };
    let clock = 0;
    const cached = cachedMembers(list, { now: () => clock });

    await cached("org_a");
    clock += 59_999;
    await cached("org_a");
    expect(calls).toBe(1);
    clock += 1;
    await cached("org_a");
    expect(calls).toBe(2);
  });

  test("does not keep an error", async () => {
    let calls = 0;
    const list: MemberLister = (clerkOrgId) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(new Error("clerk is down"));
      }
      return Promise.resolve(member(clerkOrgId));
    };
    const cached = cachedMembers(list, { now: () => 0 });

    await expect(cached("org_a")).rejects.toThrow("clerk is down");
    expect(await cached("org_a")).toEqual(member("org_a"));
    expect(calls).toBe(2);
  });

  test("keeps each organisation's answer separately", async () => {
    const calls: string[] = [];
    const list: MemberLister = (clerkOrgId) => {
      calls.push(clerkOrgId);
      return Promise.resolve(member(clerkOrgId));
    };
    const cached = cachedMembers(list, { now: () => 0 });

    expect(await cached("org_a")).toEqual(member("org_a"));
    expect(await cached("org_b")).toEqual(member("org_b"));
    expect(await cached("org_a")).toEqual(member("org_a"));
    expect(await cached("org_b")).toEqual(member("org_b"));
    expect(calls).toEqual(["org_a", "org_b"]);
  });
});
