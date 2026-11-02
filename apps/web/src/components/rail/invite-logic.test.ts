import { expect, test } from "bun:test";
import {
  canSendInvite,
  DEFAULT_INVITE_ROLE,
  INVITE_ROLE_OPTIONS,
  inviteErrorMessage,
  inviteSentMessage,
  MEMBER_PROFILE_APPEARANCE,
} from "./invite-logic.ts";

test("Member is the default role and comes first", () => {
  expect(DEFAULT_INVITE_ROLE).toBe("org:member");
  expect(INVITE_ROLE_OPTIONS.map((option) => option.label)).toEqual([
    "Member",
    "Admin",
  ]);
});

test("Send needs an address and no send in flight", () => {
  expect(canSendInvite({ email: "a@b.co", pending: false })).toBe(true);
  expect(canSendInvite({ email: "   ", pending: false })).toBe(false);
  expect(canSendInvite({ email: "a@b.co", pending: true })).toBe(false);
});

test("the confirmation names the trimmed address", () => {
  expect(inviteSentMessage(" a@b.co ")).toBe("Invitation sent to a@b.co.");
});

test("the member profile hides Clerk's own invite button", () => {
  expect(MEMBER_PROFILE_APPEARANCE.elements.membersPageInviteButton).toEqual({
    display: "none",
  });
});

test("a failed send shows the error's message, or a default", () => {
  expect(inviteErrorMessage(new Error(" Nope. "))).toBe("Nope.");
  expect(
    inviteErrorMessage(Object.assign(new Error("ignored"), { message: "  " }))
  ).toBe("Could not send the invitation.");
  expect(inviteErrorMessage("x")).toBe("Could not send the invitation.");
});
