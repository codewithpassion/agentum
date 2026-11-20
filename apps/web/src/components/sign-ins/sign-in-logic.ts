type CredentialStatus = "ok" | "needs_auth" | "revoked";

export interface SignInInput {
  authKind: "header" | "oauth" | "none";
  myCredential: { status: CredentialStatus } | null;
  oauth: { canRegister: boolean; clientConfigured: boolean } | null;
  shared: boolean;
}

export interface SignInView {
  action: "connect" | "paste" | null;
  actionLabel: string | null;
  canDisconnect: boolean;
  note: string | null;
  status: string;
}

const NO_ADMIN_SETUP_NOTE = "An admin has to set this app up first.";

const CREDENTIAL_STATUS_LABEL: Record<CredentialStatus, string> = {
  needs_auth: "Needs a new sign-in",
  ok: "Signed in",
  revoked: "Sign-in revoked",
};

const NOT_SIGNED_IN = "Not signed in";

function oauthView(input: SignInInput): SignInView {
  const canConnect =
    input.oauth !== null &&
    (input.oauth.clientConfigured || input.oauth.canRegister);
  if (input.myCredential === null) {
    // An app nobody has connected yet has no OAuth settings on record. Connect
    // finds the server's settings and registers a client itself, as on the Keys tab.
    const canStart = input.oauth === null || canConnect;
    return {
      action: canStart ? "connect" : null,
      actionLabel: canStart ? "Connect" : null,
      canDisconnect: false,
      note: canStart ? null : NO_ADMIN_SETUP_NOTE,
      status: NOT_SIGNED_IN,
    };
  }
  return {
    action: canConnect ? "connect" : null,
    actionLabel: canConnect ? "Sign in again" : null,
    canDisconnect: true,
    note: null,
    status: CREDENTIAL_STATUS_LABEL[input.myCredential.status],
  };
}

function headerView(input: SignInInput): SignInView {
  if (input.myCredential === null) {
    return {
      action: "paste",
      actionLabel: "Add sign-in",
      canDisconnect: false,
      note: null,
      status: NOT_SIGNED_IN,
    };
  }
  return {
    action: "paste",
    actionLabel: "Replace",
    canDisconnect: true,
    note: null,
    status: CREDENTIAL_STATUS_LABEL[input.myCredential.status],
  };
}

/** What a member sees for one app and what they can do about their own sign-in. */
export function signInView(input: SignInInput): SignInView {
  if (input.shared) {
    return {
      action: null,
      actionLabel: null,
      canDisconnect: false,
      note: null,
      status: "Shared by your workspace",
    };
  }
  if (input.authKind === "none") {
    return {
      action: null,
      actionLabel: null,
      canDisconnect: false,
      note: null,
      status: "No sign-in needed",
    };
  }
  if (input.authKind === "oauth") {
    return oauthView(input);
  }
  return headerView(input);
}
