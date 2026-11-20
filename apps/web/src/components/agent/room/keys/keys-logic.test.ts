import { expect, test } from "bun:test";
import type { AgentKeyApp } from "@repo/db/shared";
import {
  CREDENTIAL_MODE_LABELS,
  canSetAgentCredential,
  connectionWords,
  connectOption,
  emailWords,
  handsToWords,
  otherSignInWords,
  signInStatusWords,
  slackWords,
  toolAccessWords,
  whoseSignIn,
} from "./keys-logic.ts";

const app = (overrides: Partial<AgentKeyApp> = {}): AgentKeyApp => ({
  allowedTools: null,
  connectorId: "conn_gmail",
  connectorName: "Gmail",
  credentialMode: "user_or_agent",
  credentials: {
    agentSignIn: null,
    hasOwnSignIn: false,
    otherSignIns: null,
  },
  signIn: null,
  ...overrides,
});

test("credential mode labels and sign-in sentences name the owner plainly", () => {
  expect(CREDENTIAL_MODE_LABELS).toEqual({
    agent: "Its own",
    user: "The person asking",
    user_or_agent: "The person asking, or its own",
  });
  expect(whoseSignIn("user")).toBe("Uses the sign-in of the person asking.");
  expect(whoseSignIn("user_or_agent")).toBe(
    "Uses the sign-in of the person asking, or its own."
  );
  expect(whoseSignIn("agent")).toBe("Uses its own sign-in.");
});

test("sign-in status: no sign-in kind never reads as a missing sign-in", () => {
  const words = signInStatusWords(app({ signIn: null }), "none");
  expect(words).toBe("No sign-in needed.");
  expect(words).not.toContain("sign in yet");
  expect(words).not.toContain("not signed in");
  expect(
    signInStatusWords(
      app({
        credentialMode: "agent",
        signIn: { ownerKind: "agent", ownerName: "Sorter", status: "ok" },
      }),
      "none"
    )
  ).toBe("No sign-in needed.");
});

test("sign-in status: undefined auth kind means not loaded yet", () => {
  expect(signInStatusWords(app(), undefined)).toBeNull();
});

test("sign-in status: missing sign-in names who should sign in", () => {
  expect(
    signInStatusWords(app({ credentialMode: "agent", signIn: null }), "oauth")
  ).toBe("The agent has no sign-in yet.");
  expect(
    signInStatusWords(
      app({ credentialMode: "user_or_agent", signIn: null }),
      "oauth"
    )
  ).toBe("You have not signed in yet.");
});

test("sign-in status: each status with a sign-in", () => {
  expect(
    signInStatusWords(
      app({
        signIn: { ownerKind: "user", ownerName: "You", status: "ok" },
      }),
      "oauth"
    )
  ).toBe("You are signed in.");
  expect(
    signInStatusWords(
      app({
        signIn: { ownerKind: "agent", ownerName: "Sorter", status: "ok" },
      }),
      "oauth"
    )
  ).toBe("Sorter is signed in.");
  expect(
    signInStatusWords(
      app({
        signIn: { ownerKind: "user", ownerName: "Ana", status: "needs_auth" },
      }),
      "header"
    )
  ).toBe("The sign-in needs attention.");
  expect(
    signInStatusWords(
      app({
        signIn: { ownerKind: "user", ownerName: "Ana", status: "revoked" },
      }),
      "header"
    )
  ).toBe("The sign-in was revoked.");
});

test("tool access: all, none, one, and several", () => {
  expect(toolAccessWords(null)).toBe("Every tool");
  expect(toolAccessWords([])).toBe("No tools");
  expect(toolAccessWords(["search_threads"])).toBe("1 tool");
  expect(toolAccessWords(["search_threads", "get_thread"])).toBe("2 tools");
});

test("other sign-ins: one line per status", () => {
  expect(otherSignInWords({ ownerName: "Ana", status: "ok" })).toBe(
    "Ana: signed in"
  );
  expect(otherSignInWords({ ownerName: "Ana", status: "needs_auth" })).toBe(
    "Ana: needs attention"
  );
  expect(otherSignInWords({ ownerName: "Ana", status: "revoked" })).toBe(
    "Ana: revoked"
  );
});

const connectMine = (
  overrides: Partial<NonNullable<Parameters<typeof connectOption>[0]>> = {}
): NonNullable<Parameters<typeof connectOption>[0]> => ({
  authKind: "oauth",
  myCredential: null,
  oauth: { canRegister: true, clientConfigured: true },
  shared: false,
  ...overrides,
});

test("connect option: nothing to offer", () => {
  expect(connectOption(undefined)).toBeNull();
  expect(connectOption(connectMine({ authKind: "none" }))).toBeNull();
  expect(connectOption(connectMine({ shared: true }))).toBeNull();
});

test("connect option: a working sign-in can still be replaced", () => {
  expect(
    connectOption(connectMine({ myCredential: { status: "ok" } }))
  ).toEqual({ kind: "oauth", label: "Reconnect my account" });
});

test("sign-in status: an app on a workspace secret has no personal sign-in to be missing", () => {
  expect(
    signInStatusWords(
      app({ credentialMode: "agent", signIn: null }),
      "header",
      true
    )
  ).toBeNull();
  expect(signInStatusWords(app({ signIn: null }), "header", true)).toBeNull();
});

test("connect option: oauth labels and client handling", () => {
  expect(connectOption(connectMine())).toEqual({
    kind: "oauth",
    label: "Connect my account",
  });
  expect(
    connectOption(connectMine({ myCredential: { status: "needs_auth" } }))
  ).toEqual({ kind: "oauth", label: "Reconnect my account" });
  expect(
    connectOption(
      connectMine({ oauth: { canRegister: false, clientConfigured: false } })
    )
  ).toEqual({ kind: "needs-client" });
  expect(
    connectOption(
      connectMine({ oauth: { canRegister: true, clientConfigured: false } })
    )
  ).toEqual({ kind: "oauth", label: "Connect my account" });
  expect(connectOption(connectMine({ oauth: null }))).toEqual({
    kind: "oauth",
    label: "Connect my account",
  });
});

test("connect option: header connectors paste a key", () => {
  expect(
    connectOption({
      authKind: "header",
      myCredential: null,
      oauth: null,
      shared: false,
    })
  ).toEqual({ kind: "paste", label: "Connect my account" });
  expect(
    connectOption({
      authKind: "header",
      myCredential: { status: "revoked" },
      oauth: null,
      shared: false,
    })
  ).toEqual({ kind: "paste", label: "Reconnect my account" });
});

test("slack and email words cover every state", () => {
  expect(slackWords(null)).toBe("No Slack app yet.");
  expect(slackWords("created")).toBe("Slack app created, not installed yet.");
  expect(slackWords("installed")).toBe("Slack app installed.");
  expect(slackWords("revoked")).toBe("Slack app revoked.");
  expect(emailWords("sorter@example.com")).toBe("sorter@example.com");
  expect(emailWords(null)).toBe("No email address yet.");
});

test("connection words join the peer name with its status", () => {
  expect(
    connectionWords({
      connectionId: "conn_peer",
      peerKind: "a2a_outbound",
      peerName: "Harbour Edge",
      status: "awaiting_peer",
    })
  ).toBe("Harbour Edge, waiting for the other side");
  expect(
    connectionWords({
      connectionId: "conn_peer",
      peerKind: "a2a_outbound",
      peerName: "Harbour Edge",
      status: "active",
    })
  ).toBe("Harbour Edge, active");
});

test("hands-to words: none, one, and several", () => {
  expect(handsToWords([])).toBe("Hands work to no one.");
  expect(handsToWords([{ agentId: "agent_2", name: "Scout" }])).toBe(
    "Hands work to Scout."
  );
  expect(
    handsToWords([
      { agentId: "agent_2", name: "Scout" },
      { agentId: "agent_3", name: "Pilot" },
    ])
  ).toBe("Hands work to Scout, Pilot.");
});

const agentOwnedBy = (
  ownerUserId: string | null,
  createdBy = "user_creator"
): { createdBy: string; ownerUserId: string | null } => ({
  createdBy,
  ownerUserId,
});

test("the agent's owner, by ownerUserId, may set its credential", () => {
  expect(
    canSetAgentCredential({
      agent: agentOwnedBy("user_owner"),
      isAdmin: false,
      userId: "user_owner",
    })
  ).toBe(true);
});

test("with no ownerUserId, the creator counts as the owner", () => {
  expect(
    canSetAgentCredential({
      agent: agentOwnedBy(null, "user_creator"),
      isAdmin: false,
      userId: "user_creator",
    })
  ).toBe(true);
});

test("an owner set by ownerUserId replaces the creator as the owner", () => {
  expect(
    canSetAgentCredential({
      agent: agentOwnedBy("user_owner", "user_creator"),
      isAdmin: false,
      userId: "user_creator",
    })
  ).toBe(false);
});

test("an org admin who is not the owner may set the credential", () => {
  expect(
    canSetAgentCredential({
      agent: agentOwnedBy("user_owner"),
      isAdmin: true,
      userId: "user_admin",
    })
  ).toBe(true);
});

test("a plain member who is neither owner nor admin may not set the credential", () => {
  expect(
    canSetAgentCredential({
      agent: agentOwnedBy("user_owner"),
      isAdmin: false,
      userId: "user_member",
    })
  ).toBe(false);
});

test("a missing or empty user id may not set the credential unless admin", () => {
  const agent = agentOwnedBy(null, "user_creator");
  expect(
    canSetAgentCredential({ agent, isAdmin: false, userId: undefined })
  ).toBe(false);
  expect(canSetAgentCredential({ agent, isAdmin: false, userId: null })).toBe(
    false
  );
  expect(canSetAgentCredential({ agent, isAdmin: false, userId: "" })).toBe(
    false
  );
  expect(
    canSetAgentCredential({ agent, isAdmin: true, userId: undefined })
  ).toBe(true);
});
