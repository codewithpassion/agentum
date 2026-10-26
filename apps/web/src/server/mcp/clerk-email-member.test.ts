import { expect, test } from "bun:test";
import {
  type ClerkEmailUser,
  emailMemberLookup,
} from "./clerk-email-member.ts";

const verified = (emailAddress: string) => ({
  emailAddress,
  verification: { status: "verified" },
});

const user = (
  id: string,
  emailAddresses: ClerkEmailUser["emailAddresses"]
): ClerkEmailUser => ({ emailAddresses, id });

const lookupWith = (users: ClerkEmailUser[], members: string[] = []) =>
  emailMemberLookup({
    findUsers: () => Promise.resolve(users),
    isOrgMember: (userId, clerkOrgId) =>
      Promise.resolve(clerkOrgId === "org_a" && members.includes(userId)),
  });

test("a verified exact match in the org returns the user id", async () => {
  const lookup = lookupWith(
    [user("user_1", [verified("ana@example.com")])],
    ["user_1"]
  );
  expect(await lookup("ana@example.com", "org_a")).toBe("user_1");
});

test("the match is case-insensitive and ignores surrounding space", async () => {
  const lookup = lookupWith(
    [user("user_1", [verified("Ana@Example.com")])],
    ["user_1"]
  );
  expect(await lookup("  ana@EXAMPLE.com \n", "org_a")).toBe("user_1");
});

test("an unverified address does not match", async () => {
  const lookup = lookupWith(
    [
      user("user_1", [
        {
          emailAddress: "ana@example.com",
          verification: { status: "unverified" },
        },
      ]),
    ],
    ["user_1"]
  );
  expect(await lookup("ana@example.com", "org_a")).toBeNull();
});

test("an address with no verification record does not match", async () => {
  const lookup = lookupWith(
    [user("user_1", [{ emailAddress: "ana@example.com", verification: null }])],
    ["user_1"]
  );
  expect(await lookup("ana@example.com", "org_a")).toBeNull();
});

test("an unknown email returns null", async () => {
  const lookup = lookupWith(
    [user("user_1", [verified("ana@example.com")])],
    ["user_1"]
  );
  expect(await lookup("bo@example.com", "org_a")).toBeNull();
});

test("a verified user who is not in the org returns null", async () => {
  const lookup = lookupWith([user("user_1", [verified("ana@example.com")])]);
  expect(await lookup("ana@example.com", "org_a")).toBeNull();
});

test("two different matching users return null", async () => {
  const lookup = lookupWith(
    [
      user("user_1", [verified("ana@example.com")]),
      user("user_2", [verified("ana@example.com")]),
    ],
    ["user_1", "user_2"]
  );
  expect(await lookup("ana@example.com", "org_a")).toBeNull();
});

test("one user listed twice still counts as one match", async () => {
  const lookup = lookupWith(
    [
      user("user_1", [verified("ana@example.com")]),
      user("user_1", [verified("ana@example.com")]),
    ],
    ["user_1"]
  );
  expect(await lookup("ana@example.com", "org_a")).toBe("user_1");
});

test("an empty or blank email returns null without asking Clerk", async () => {
  let asked = 0;
  const lookup = emailMemberLookup({
    findUsers: () => {
      asked += 1;
      return Promise.resolve([]);
    },
    isOrgMember: () => Promise.resolve(true),
  });
  expect(await lookup("", "org_a")).toBeNull();
  expect(await lookup("   ", "org_a")).toBeNull();
  expect(asked).toBe(0);
});
