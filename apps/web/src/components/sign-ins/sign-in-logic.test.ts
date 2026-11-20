import { expect, test } from "bun:test";
import { type SignInInput, signInView } from "./sign-in-logic.ts";

const CLIENT_READY = { canRegister: false, clientConfigured: true };
const CAN_REGISTER = { canRegister: true, clientConfigured: false };
const NO_CLIENT = { canRegister: false, clientConfigured: false };

function input(overrides: Partial<SignInInput>): SignInInput {
  return {
    authKind: "header",
    myCredential: null,
    oauth: null,
    shared: false,
    ...overrides,
  };
}

test("A shared app has no action and cannot be disconnected", () => {
  for (const authKind of ["header", "oauth", "none"] as const) {
    const view = signInView(
      input({
        authKind,
        myCredential: { status: "ok" },
        oauth: CLIENT_READY,
        shared: true,
      })
    );
    expect(view).toEqual({
      action: null,
      actionLabel: null,
      canDisconnect: false,
      note: null,
      status: "Shared by your workspace",
    });
  }
});

test("An app with no sign-in needs nothing", () => {
  expect(signInView(input({ authKind: "none" }))).toEqual({
    action: null,
    actionLabel: null,
    canDisconnect: false,
    note: null,
    status: "No sign-in needed",
  });
});

test("OAuth without a credential connects when a client is set or can be registered", () => {
  for (const oauth of [CLIENT_READY, CAN_REGISTER]) {
    expect(signInView(input({ authKind: "oauth", oauth }))).toEqual({
      action: "connect",
      actionLabel: "Connect",
      canDisconnect: false,
      note: null,
      status: "Not signed in",
    });
  }
});

test("OAuth without a credential and no client asks an admin to set up the app", () => {
  expect(signInView(input({ authKind: "oauth", oauth: NO_CLIENT }))).toEqual({
    action: null,
    actionLabel: null,
    canDisconnect: false,
    note: "An admin has to set this app up first.",
    status: "Not signed in",
  });
  expect(signInView(input({ authKind: "oauth", oauth: null }))).toEqual({
    action: null,
    actionLabel: null,
    canDisconnect: false,
    note: "An admin has to set this app up first.",
    status: "Not signed in",
  });
});

test("OAuth credential statuses map to their labels and can sign in again", () => {
  const cases = [
    ["ok", "Signed in"],
    ["needs_auth", "Needs a new sign-in"],
    ["revoked", "Sign-in revoked"],
  ] as const;
  for (const [status, label] of cases) {
    expect(
      signInView(
        input({
          authKind: "oauth",
          myCredential: { status },
          oauth: CLIENT_READY,
        })
      )
    ).toEqual({
      action: "connect",
      actionLabel: "Sign in again",
      canDisconnect: true,
      note: null,
      status: label,
    });
  }
});

test("OAuth credential without a usable client can still be disconnected", () => {
  for (const oauth of [NO_CLIENT, null]) {
    expect(
      signInView(
        input({ authKind: "oauth", myCredential: { status: "ok" }, oauth })
      )
    ).toEqual({
      action: null,
      actionLabel: null,
      canDisconnect: true,
      note: null,
      status: "Signed in",
    });
  }
});

test("Header without a credential adds a sign-in", () => {
  expect(signInView(input({ authKind: "header" }))).toEqual({
    action: "paste",
    actionLabel: "Add sign-in",
    canDisconnect: false,
    note: null,
    status: "Not signed in",
  });
});

test("Header credential statuses map to their labels and can be replaced", () => {
  const cases = [
    ["ok", "Signed in"],
    ["needs_auth", "Needs a new sign-in"],
    ["revoked", "Sign-in revoked"],
  ] as const;
  for (const [status, label] of cases) {
    expect(
      signInView(input({ authKind: "header", myCredential: { status } }))
    ).toEqual({
      action: "paste",
      actionLabel: "Replace",
      canDisconnect: true,
      note: null,
      status: label,
    });
  }
});
