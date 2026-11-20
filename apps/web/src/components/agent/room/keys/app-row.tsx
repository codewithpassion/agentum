import {
  type AgentKeyApp,
  CREDENTIAL_MODES,
  type CredentialMode,
} from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { ConfirmButton } from "#/components/confirm-action/confirm-button";
import { connectHref } from "#/components/connectors/connect-link.ts";
import { SecretNotice } from "#/components/connectors/secret-notice";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import type { ConnectorRecord, RouterOutputs } from "#/integrations/trpc/types";
import {
  type ConnectOption,
  CREDENTIAL_MODE_LABELS,
  CREDENTIAL_STATUS_WORDS,
  connectOption,
  otherSignInWords,
  signInStatusWords,
  toolAccessWords,
  whoseSignIn,
} from "./keys-logic.ts";

type MySignIn = RouterOutputs["connectors"]["mine"][number];

const mutedText = "text-muted-foreground text-xs";

/** Whether the member can connect this app as the agent from this row. */
const canConnectAsAgent = (
  app: AgentKeyApp,
  mine: MySignIn | undefined,
  canEdit: boolean,
  canSetCredential: boolean
): boolean => {
  const mayChange = canEdit && canSetCredential;
  if (!mayChange || app.credentialMode === "user" || mine === undefined) {
    return false;
  }
  if (mine.authKind !== "oauth" && mine.authKind !== "header") {
    return false;
  }
  // A working agent sign-in can still be replaced, so Reconnect stays.
  return !mine.shared;
};

const CONNECTOR_STATUS_WORDS: Record<ConnectorRecord["status"], string> = {
  needs_auth: "Needs sign-in",
  ok: "Ready",
};

/** What the connector's own state says, in words. */
const connectorStatus = (connector: ConnectorRecord): string =>
  connector.headerTemplate && !connector.secretId
    ? "Needs a secret"
    : CONNECTOR_STATUS_WORDS[connector.status];

/** An OAuth app with no client and no way to register one cannot be connected as the agent. */
const oauthCanRun = (mine: MySignIn): boolean =>
  mine.oauth === null || mine.oauth.clientConfigured || mine.oauth.canRegister;

/** The sign-in controls of one row: the key's secret, connect for you, connect for the agent. */
function ConnectControls({
  agentId,
  app,
  canEdit,
  canSetCredential,
  connector,
  isAdmin,
  mine,
  onPaste,
}: {
  agentId: string;
  app: AgentKeyApp;
  canEdit: boolean;
  canSetCredential: boolean;
  connector: ConnectorRecord | undefined;
  isAdmin: boolean;
  mine: MySignIn | undefined;
  onPaste: (connectorId: string, as: "me" | "agent") => void;
}) {
  const { connectorId } = app;
  const { agentSignIn } = app.credentials;
  const handlePasteMe = useCallback(
    () => onPaste(connectorId, "me"),
    [connectorId, onPaste]
  );
  const handlePasteAgent = useCallback(
    () => onPaste(connectorId, "agent"),
    [connectorId, onPaste]
  );
  // An app on the agent's own sign-in never uses the person's, so no connect for them.
  const connect: ConnectOption =
    app.credentialMode === "agent" ? null : connectOption(mine);
  let connectMine: ReactNode = null;
  if (connect?.kind === "needs-client") {
    connectMine = (
      <p className={mutedText}>
        This app needs an admin to set up its client before anyone can connect.{" "}
        {isAdmin ? (
          <Link to="/settings/connectors">
            Set the client on the Apps page.
          </Link>
        ) : null}
      </p>
    );
  } else if (connect?.kind === "paste") {
    connectMine = (
      <Button onClick={handlePasteMe} size="sm" variant="outline">
        {connect.label}
      </Button>
    );
  } else if (connect?.kind === "oauth") {
    connectMine = (
      <Button asChild size="sm" variant="outline">
        <a
          href={connectHref({
            as: "user",
            connectorId,
            returnTo: `/agents/${agentId}?tab=keys`,
          })}
        >
          {connect.label}
        </a>
      </Button>
    );
  }

  let secretLine: ReactNode = null;
  if (mine?.shared === true && connector !== undefined) {
    secretLine = connector.secretName ? (
      <p className={mutedText}>Key from secret {connector.secretName}</p>
    ) : (
      <SecretNotice connectorId={connector.id} />
    );
  }

  let connectAgent: ReactNode = null;
  if (
    mine !== undefined &&
    canConnectAsAgent(app, mine, canEdit, canSetCredential)
  ) {
    if (mine.authKind === "header") {
      connectAgent = (
        <Button onClick={handlePasteAgent} size="sm" variant="outline">
          Paste as this agent
        </Button>
      );
    } else if (oauthCanRun(mine)) {
      connectAgent = (
        <Button asChild size="sm" variant="outline">
          <a
            href={connectHref({
              as: `agent:${agentId}`,
              connectorId,
              returnTo: `/agents/${agentId}?tab=keys`,
            })}
          >
            {agentSignIn === null
              ? "Connect as this agent"
              : "Reconnect as this agent"}
          </a>
        </Button>
      );
    }
  }

  return (
    <>
      {secretLine}
      {connectMine}
      {connectAgent}
    </>
  );
}

export function AppRow({
  agentId,
  app,
  canEdit,
  canSetCredential,
  connector,
  isAdmin,
  mine,
  onChangeMode,
  onChooseTools,
  onPaste,
  onRemove,
}: {
  agentId: string;
  app: AgentKeyApp;
  canEdit: boolean;
  /** Whether the person may set or replace the agent's own credential (its owner or an admin). */
  canSetCredential: boolean;
  /** The full connector, for its own status and secret. Undefined until it has loaded. */
  connector: ConnectorRecord | undefined;
  isAdmin: boolean;
  mine: MySignIn | undefined;
  onChangeMode: (connectorId: string, mode: CredentialMode) => void;
  onChooseTools: (connectorId: string) => void;
  onPaste: (connectorId: string, as: "me" | "agent") => void;
  onRemove: (connectorId: string) => void;
}) {
  const { connectorId } = app;

  const handleModeChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const mode = CREDENTIAL_MODES.find((item) => item === event.target.value);
      if (mode !== undefined) {
        onChangeMode(connectorId, mode);
      }
    },
    [connectorId, onChangeMode]
  );
  const handleChooseTools = useCallback(
    () => onChooseTools(connectorId),
    [connectorId, onChooseTools]
  );
  const handleRemove = useCallback(
    () => onRemove(connectorId),
    [connectorId, onRemove]
  );

  const signInLine =
    mine === undefined
      ? null
      : signInStatusWords(app, mine.authKind, mine.shared);
  const otherSignIns = app.credentials.otherSignIns ?? [];
  const { agentSignIn } = app.credentials;

  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{app.connectorName}</p>
          {connector === undefined ? null : (
            <Badge
              variant={connector.status === "ok" ? "default" : "destructive"}
            >
              {connectorStatus(connector)}
            </Badge>
          )}
        </div>
        <div className="flex flex-col gap-0.5">
          {/* An app with no sign-in, or on a workspace secret, has no person's sign-in to describe. */}
          {mine?.authKind === "none" || mine?.shared === true ? null : (
            <p className="text-sm">{whoseSignIn(app.credentialMode)}</p>
          )}
          {signInLine === null ? null : (
            <p className={mutedText}>{signInLine}</p>
          )}
        </div>
        {otherSignIns.length > 0 ? (
          <p className={mutedText}>
            Other people:{" "}
            {otherSignIns.map((item) => otherSignInWords(item)).join(", ")}
          </p>
        ) : null}
        {agentSignIn === null ? null : (
          <p className={mutedText}>
            Its own sign-in: {CREDENTIAL_STATUS_WORDS[agentSignIn.status]}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <span className={mutedText}>{toolAccessWords(app.allowedTools)}</span>
          <Button
            disabled={!canEdit}
            onClick={handleChooseTools}
            size="sm"
            variant="outline"
          >
            Allowed tools
          </Button>
        </div>
        <ConnectControls
          agentId={agentId}
          app={app}
          canEdit={canEdit}
          canSetCredential={canSetCredential}
          connector={connector}
          isAdmin={isAdmin}
          mine={mine}
          onPaste={onPaste}
        />
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
        {mine?.authKind === "none" ? null : (
          <NativeSelect
            aria-label="Whose sign-in it uses"
            disabled={!canEdit}
            onChange={handleModeChange}
            value={app.credentialMode}
          >
            {CREDENTIAL_MODES.map((mode) => (
              <NativeSelectOption key={mode} value={mode}>
                {CREDENTIAL_MODE_LABELS[mode]}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
        <ConfirmButton
          description={`Remove ${app.connectorName} from this agent? It can be added again later.`}
          disabled={!canEdit}
          onConfirm={handleRemove}
          size="sm"
          title="Remove app?"
          variant="outline"
        >
          Remove
        </ConfirmButton>
      </div>
    </li>
  );
}
