import { expect, test } from "bun:test";
import {
  invitationReturnPath,
  invitationStep,
  parseInvitationSearch,
} from "./accept-invitation.ts";

test("a signed-in session activates the inviting organisation", () => {
  expect(
    invitationStep({ search: { org: "org_a", ticket: "t" }, signedIn: true })
  ).toEqual({ kind: "activate", org: "org_a" });
  expect(invitationStep({ search: {}, signedIn: true })).toEqual({
    kind: "desk",
  });
});

test("a signed-out session with a ticket signs up or in by status", () => {
  const base = { org: "org_a", ticket: "t" };
  expect(
    invitationStep({ search: { ...base, status: "sign_up" }, signedIn: false })
  ).toEqual({ kind: "sign-up" });
  expect(
    invitationStep({ search: { ...base, status: "sign_in" }, signedIn: false })
  ).toEqual({ kind: "sign-in" });
  expect(invitationStep({ search: base, signedIn: false })).toEqual({
    kind: "sign-up",
  });
});

test("a signed-out session with no ticket falls back to sign-in", () => {
  expect(invitationStep({ search: { org: "org_a" }, signedIn: false })).toEqual(
    { kind: "sign-in" }
  );
});

test("the return path keeps the organisation and drops the ticket", () => {
  expect(invitationReturnPath("org_a")).toBe("/accept-invitation?org=org_a");
  expect(invitationReturnPath(undefined)).toBe("/accept-invitation");
});

test("the search parser reads Clerk's keys and ignores everything else", () => {
  expect(
    parseInvitationSearch({
      __clerk_status: "sign_in",
      __clerk_ticket: "tkt",
      org: "org_a",
      other: "x",
    })
  ).toEqual({ org: "org_a", status: "sign_in", ticket: "tkt" });
  expect(parseInvitationSearch({ __clerk_ticket: "", org: 3 })).toEqual({
    org: undefined,
    status: undefined,
    ticket: undefined,
  });
});
