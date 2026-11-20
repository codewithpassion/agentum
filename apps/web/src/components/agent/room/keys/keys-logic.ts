// Pure words and rules for the Keys tab. No React, no calls.
import type {
  AgentKeyApp,
  AgentKeyConnection,
  AgentKeyHandsTo,
  ConnectorAuthKind,
  CredentialMode,
  CredentialStatus,
  SlackAppStatus,
} from "@repo/db/shared";
import { statusWords } from "#/components/connections/connections-logic.ts";
import type { ConnectorRecord } from "#/integrations/trpc/types";

export const CREDENTIAL_MODE_LABELS: Record<CredentialMode, string> = {
  agent: "Its own",
  user: "The person asking",
  user_or_agent: "The person asking, or its own",
};

const WHOSE_SIGN_IN: Record<CredentialMode, string> = {
  agent: "Uses its own sign-in.",
  user: "Uses the sign-in of the person asking.",
  user_or_agent: "Uses the sign-in of the person asking, or its own.",
};

export const whoseSignIn = (mode: CredentialMode): string =>
  WHOSE_SIGN_IN[mode];

/** Whether the app runs on a key from a workspace secret, which no person signs in for. */
export const isSecretBacked = (
  connector: Pick<ConnectorRecord, "headerTemplate" | "secretId">
): boolean => Boolean(connector.secretId || connector.headerTemplate);

/**
 * One line on whether the app can act for this agent. Null while the auth kind
 * is not loaded, and for an app on a workspace secret (the row says which
 * secret instead): neither has a personal sign-in to be missing.
 */
export const signInStatusWords = (
  app: AgentKeyApp,
  authKind: ConnectorAuthKind | undefined,
  secretBacked = false
): string | null => {
  if (authKind === undefined || secretBacked) {
    return null;
  }
  if (authKind === "none") {
    return "No sign-in needed.";
  }
  if (app.signIn === null) {
    return app.credentialMode === "agent"
      ? "The agent has no sign-in yet."
      : "You have not signed in yet.";
  }
  const { ownerKind, ownerName, status } = app.signIn;
  if (status === "needs_auth") {
    return "The sign-in needs attention.";
  }
  if (status === "revoked") {
    return "The sign-in was revoked.";
  }
  return ownerKind === "user"
    ? "You are signed in."
    : `${ownerName} is signed in.`;
};

export const toolAccessWords = (allowedTools: string[] | null): string => {
  if (allowedTools === null) {
    return "Every tool";
  }
  if (allowedTools.length === 0) {
    return "No tools";
  }
  if (allowedTools.length === 1) {
    return "1 tool";
  }
  return `${allowedTools.length} tools`;
};

export const CREDENTIAL_STATUS_WORDS: Record<CredentialStatus, string> = {
  needs_auth: "needs attention",
  ok: "signed in",
  revoked: "revoked",
};

export const otherSignInWords = (item: {
  ownerName: string;
  status: CredentialStatus;
}): string => `${item.ownerName}: ${CREDENTIAL_STATUS_WORDS[item.status]}`;

export type ConnectOption =
  | { kind: "oauth" | "paste"; label: string }
  | { kind: "needs-client" }
  | null;

/** The one action the Keys tab offers to connect the caller's own account, or null when none applies. */
export const connectOption = (
  mine:
    | {
        authKind: ConnectorAuthKind;
        myCredential: { status: CredentialStatus } | null;
        oauth: { canRegister: boolean; clientConfigured: boolean } | null;
        shared: boolean;
      }
    | undefined
): ConnectOption => {
  if (mine === undefined) {
    return null;
  }
  if (mine.authKind === "none" || mine.shared) {
    return null;
  }
  // A working sign-in can still be replaced, so Reconnect stays.
  const label =
    mine.myCredential === null ? "Connect my account" : "Reconnect my account";
  if (mine.authKind === "header") {
    return { kind: "paste", label };
  }
  const { oauth } = mine;
  if (oauth !== null && !oauth.clientConfigured && !oauth.canRegister) {
    return { kind: "needs-client" };
  }
  return { kind: "oauth", label };
};

const SLACK_WORDS: Record<SlackAppStatus, string> = {
  created: "Slack app created, not installed yet.",
  installed: "Slack app installed.",
  revoked: "Slack app revoked.",
};

export const slackWords = (status: SlackAppStatus | null): string =>
  status === null ? "No Slack app yet." : SLACK_WORDS[status];

export const emailWords = (address: string | null): string =>
  address ?? "No email address yet.";

export const connectionWords = (connection: AgentKeyConnection): string =>
  `${connection.peerName}, ${statusWords(connection.status).toLowerCase()}`;

export const handsToWords = (handsTo: AgentKeyHandsTo[]): string =>
  handsTo.length === 0
    ? "Hands work to no one."
    : `Hands work to ${handsTo.map((agent) => agent.name).join(", ")}.`;
