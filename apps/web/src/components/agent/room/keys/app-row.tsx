import {
  type AgentKeyApp,
  CREDENTIAL_MODES,
  type CredentialMode,
  type CredentialStatus,
} from "@repo/db/shared";
import { type ChangeEvent, type ReactNode, useCallback } from "react";
import { ConfirmButton } from "#/components/confirm-action/confirm-button";
import { connectHref } from "#/components/connectors/connect-link.ts";
import { Button } from "#/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import type { RouterOutputs } from "#/integrations/trpc/types";
import {
  type ConnectOption,
  CREDENTIAL_MODE_LABELS,
  connectOption,
  otherSignInWords,
  signInStatusWords,
  toolAccessWords,
  whoseSignIn,
} from "./keys-logic.ts";

type MySignIn = RouterOutputs["connectors"]["mine"][number];

const AGENT_SIGN_IN_WORDS: Record<CredentialStatus, string> = {
  needs_auth: "needs attention",
  ok: "signed in",
  revoked: "revoked",
};

const mutedText = "text-muted-foreground text-xs";

/** Whether the member can connect this app as the agent from this row. */
const canConnectAsAgent = (
  app: AgentKeyApp,
  mine: MySignIn | undefined,
  canEdit: boolean
): boolean => {
  if (!canEdit || app.credentialMode === "user" || mine === undefined) {
    return false;
  }
  if (mine.authKind !== "oauth" && mine.authKind !== "header") {
    return false;
  }
  if (mine.shared) {
    return false;
  }
  const agentStatus = app.credentials.agentSignIn?.status;
  return agentStatus === undefined || agentStatus !== "ok";
};

/** An OAuth app with no client and no way to register one cannot be connected as the agent. */
const oauthCanRun = (mine: MySignIn): boolean =>
  mine.oauth === null || mine.oauth.clientConfigured || mine.oauth.canRegister;

export function AppRow({
  agentId,
  app,
  canEdit,
  mine,
  onChangeMode,
  onChooseTools,
  onPaste,
  onRemove,
}: {
  agentId: string;
  app: AgentKeyApp;
  canEdit: boolean;
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
  const handlePasteMe = useCallback(
    () => onPaste(connectorId, "me"),
    [connectorId, onPaste]
  );
  const handlePasteAgent = useCallback(
    () => onPaste(connectorId, "agent"),
    [connectorId, onPaste]
  );
  const handleRemove = useCallback(
    () => onRemove(connectorId),
    [connectorId, onRemove]
  );

  const signInLine =
    mine === undefined ? null : signInStatusWords(app, mine.authKind);
  const otherSignIns = app.credentials.otherSignIns ?? [];
  const { agentSignIn } = app.credentials;

  const connect: ConnectOption = connectOption(mine);
  let connectMine: ReactNode = null;
  if (connect?.kind === "needs-client") {
    connectMine = (
      <p className={mutedText}>
        This app needs an admin to set up its client before anyone can connect.
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

  let connectAgent: ReactNode = null;
  if (mine !== undefined && canConnectAsAgent(app, mine, canEdit)) {
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
            Connect as this agent
          </a>
        </Button>
      );
    }
  }

  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="font-medium">{app.connectorName}</p>
        <div className="flex flex-col gap-0.5">
          <p className="text-sm">{whoseSignIn(app.credentialMode)}</p>
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
            Its own sign-in: {AGENT_SIGN_IN_WORDS[agentSignIn.status]}
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
        {connectMine}
        {connectAgent}
      </div>
      <div className="flex shrink-0 flex-col gap-2 sm:items-end">
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
        <ConfirmButton
          description={`Remove ${app.connectorName} from this agent? It can be added again later.`}
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
