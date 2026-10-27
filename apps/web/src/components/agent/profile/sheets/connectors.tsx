import { CREDENTIAL_MODES, type CredentialMode } from "@repo/db/shared";
import { Link } from "@tanstack/react-router";
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { ConfirmButton } from "#/components/confirm-action/confirm-button";
import { toolAccessLabel } from "#/components/connectors/allowed-tools";
import { AllowedToolsDialog } from "#/components/connectors/allowed-tools-dialog";
import { connectHref } from "#/components/connectors/connect-link";
import { OAuthClientDialog } from "#/components/connectors/oauth-client-dialog";
import { PasteCredentialDialog } from "#/components/connectors/paste-credential-dialog";
import {
  ResponsiveActions,
  ResponsiveCell,
  ResponsiveTable,
} from "#/components/responsive-table/responsive-table";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "#/components/ui/native-select";
import {
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  AssignmentRecord,
  ConnectorRecord,
  CredentialRecord,
} from "#/integrations/trpc/types";
import type { AgentPanelProps } from "./props.ts";

type PasteAs = "me" | "agent";

interface ConnectorsState {
  assignments: AssignmentRecord[];
  connectors: ConnectorRecord[];
}

const MODE_LABELS: Record<CredentialMode, string> = {
  agent: "Always the agent",
  user: "Only the person who started the run",
  user_or_agent: "The person who started the run, or the agent when nobody did",
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

const parseMode = (value: string): CredentialMode =>
  CREDENTIAL_MODES.find((mode) => mode === value) ?? "user_or_agent";

const credentialStatus = (
  credential: CredentialRecord | undefined | null,
  missing = "not pasted"
) => (credential ? credential.status : missing);

function AssignedConnectorRow({
  agentId,
  assignment,
  connector,
  onChangeMode,
  onChooseTools,
  onPaste,
  onRemove,
  onSetClient,
}: {
  agentId: string;
  assignment: AssignmentRecord;
  connector: ConnectorRecord;
  onChangeMode: (connectorId: string, mode: CredentialMode) => void;
  onChooseTools: (connectorId: string) => void;
  onPaste: (connectorId: string, as: PasteAs) => void;
  onRemove: (connectorId: string) => void;
  onSetClient: (connectorId: string) => void;
}) {
  const connectorId = connector.id;
  const agentCredential = connector.agentCredentials.find(
    (credential) => credential.ownerId === agentId
  );

  const handleModeChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      onChangeMode(connectorId, parseMode(event.target.value)),
    [connectorId, onChangeMode]
  );
  const handleRemove = useCallback(
    () => onRemove(connectorId),
    [connectorId, onRemove]
  );
  const pasteAsMe = useCallback(
    () => onPaste(connectorId, "me"),
    [connectorId, onPaste]
  );
  const pasteAsAgent = useCallback(
    () => onPaste(connectorId, "agent"),
    [connectorId, onPaste]
  );
  const setClient = useCallback(
    () => onSetClient(connectorId),
    [connectorId, onSetClient]
  );
  const chooseTools = useCallback(
    () => onChooseTools(connectorId),
    [connectorId, onChooseTools]
  );

  let credentials: ReactNode;
  if (connector.authKind === "header") {
    credentials = (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          You: {credentialStatus(connector.myCredential)}
        </span>
        <span className="text-muted-foreground">
          Agent: {credentialStatus(agentCredential)}
        </span>
        <Button onClick={pasteAsMe} size="sm" variant="outline">
          Paste as me
        </Button>
        <Button onClick={pasteAsAgent} size="sm" variant="outline">
          Paste as this agent
        </Button>
      </div>
    );
  } else if (connector.authKind === "oauth") {
    const { oauth } = connector;
    const canConnect =
      oauth !== null && (oauth.clientConfigured || oauth.canRegister);
    const meHref = connectHref({
      as: "user",
      connectorId,
      returnTo: `/agents/${agentId}?sheet=tools`,
    });
    const agentHref = connectHref({
      as: `agent:${agentId}`,
      connectorId,
      returnTo: `/agents/${agentId}?sheet=tools`,
    });
    credentials = (
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          You: {credentialStatus(connector.myCredential, "not connected")}
        </span>
        <span className="text-muted-foreground">
          Agent: {credentialStatus(agentCredential, "not connected")}
        </span>
        {canConnect ? (
          <>
            <Button asChild size="sm" variant="outline">
              <a href={meHref}>
                {connector.myCredential
                  ? "Re-authorise as me"
                  : "Connect as me"}
              </a>
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={agentHref}>
                {agentCredential
                  ? "Re-authorise as this agent"
                  : "Connect as this agent"}
              </a>
            </Button>
          </>
        ) : null}
        <Button onClick={setClient} size="sm" variant="outline">
          Set client
        </Button>
      </div>
    );
  }

  return (
    <TableRow>
      <ResponsiveCell className="font-medium" label="Name">
        <div className="flex flex-col gap-1.5">
          <span>{connector.name}</span>
          {credentials}
        </div>
      </ResponsiveCell>
      <ResponsiveCell
        className="font-mono text-muted-foreground text-xs"
        label="URL"
      >
        {connector.url}
      </ResponsiveCell>
      <ResponsiveCell label="Status">
        <Badge variant={connector.status === "ok" ? "default" : "destructive"}>
          {connector.status}
        </Badge>
      </ResponsiveCell>
      <ResponsiveCell label="Credential mode">
        <NativeSelect
          aria-label="Credential mode"
          onChange={handleModeChange}
          value={assignment.credentialMode}
        >
          {CREDENTIAL_MODES.map((mode) => (
            <NativeSelectOption key={mode} value={mode}>
              {MODE_LABELS[mode]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </ResponsiveCell>
      <ResponsiveCell label="Tools">
        <div className="flex flex-col items-start gap-1.5">
          <span className="text-muted-foreground text-xs">
            {toolAccessLabel(assignment.allowedTools, connector.tools)}
          </span>
          <Button onClick={chooseTools} size="sm" variant="outline">
            Choose tools
          </Button>
        </div>
      </ResponsiveCell>
      <ResponsiveActions className="text-right">
        <ConfirmButton
          description={`Remove ${connector.name} from this agent? It can be added again later.`}
          onConfirm={handleRemove}
          size="sm"
          title="Remove connector?"
          variant="outline"
        >
          Remove
        </ConfirmButton>
      </ResponsiveActions>
    </TableRow>
  );
}

export function ConnectorsPanel({ agent }: AgentPanelProps) {
  const agentId = agent.id;
  const agentName = agent.name;
  const agentRef = useMemo(
    () => ({ id: agentId, name: agentName }),
    [agentId, agentName]
  );

  const [state, setState] = useState<ConnectorsState | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [addId, setAddId] = useState("");
  const [oauthId, setOauthId] = useState<string | null>(null);
  const [toolsId, setToolsId] = useState<string | null>(null);
  const [paste, setPaste] = useState<{
    connectorId: string;
    as: PasteAs;
  } | null>(null);

  const fetchState = useCallback(async (): Promise<ConnectorsState> => {
    const [connectors, assignments] = await Promise.all([
      getTrpc().connectors.list.query(),
      getTrpc().connectors.assignments.query({ agentId }),
    ]);
    return { assignments, connectors };
  }, [agentId]);

  useEffect(() => {
    let active = true;
    fetchState()
      .then((next) => {
        if (active) {
          setState(next);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setError(errorMessage(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [fetchState]);

  const reload = useCallback(() => {
    fetchState()
      .then((next) => {
        setState(next);
        setError(undefined);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [fetchState]);

  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (cause) {
        setError(errorMessage(cause));
        return;
      }
      reload();
    },
    [reload]
  );

  const changeMode = useCallback(
    (connectorId: string, credentialMode: CredentialMode) =>
      act(() =>
        getTrpc().connectors.assign.mutate({
          agentId,
          connectorId,
          credentialMode,
        })
      ),
    [act, agentId]
  );

  const removeConnector = useCallback(
    (connectorId: string) =>
      act(() => getTrpc().connectors.unassign.mutate({ agentId, connectorId })),
    [act, agentId]
  );

  const handleAddChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setAddId(event.target.value);
    },
    []
  );

  const assignSelected = useCallback(() => {
    const connectorId = addId;
    setAddId("");
    return act(() =>
      getTrpc().connectors.assign.mutate({ agentId, connectorId })
    );
  }, [act, addId, agentId]);

  const openPaste = useCallback(
    (connectorId: string, as: PasteAs) => setPaste({ as, connectorId }),
    []
  );

  const closePaste = useCallback(() => setPaste(null), []);

  const pasteSaved = useCallback(() => {
    setPaste(null);
    reload();
  }, [reload]);

  const openChooseTools = useCallback(
    (connectorId: string) => setToolsId(connectorId),
    []
  );

  const closeChooseTools = useCallback(() => setToolsId(null), []);

  const toolsSaved = useCallback(() => {
    setToolsId(null);
    reload();
  }, [reload]);

  const openSetClient = useCallback(
    (connectorId: string) => setOauthId(connectorId),
    []
  );

  const closeSetClient = useCallback(() => setOauthId(null), []);

  const clientSaved = useCallback(() => {
    setOauthId(null);
    reload();
  }, [reload]);

  if (state === undefined) {
    return error === undefined ? (
      <p className="text-muted-foreground text-sm">Loading connectors.</p>
    ) : (
      <p className="text-destructive text-sm">{error}</p>
    );
  }

  const { assignments, connectors } = state;
  const assignedIds = new Set(assignments.map((item) => item.connectorId));
  const assignedRows = assignments.flatMap((assignment) => {
    const connector = connectors.find(
      (item) => item.id === assignment.connectorId
    );
    return connector ? [{ assignment, connector }] : [];
  });
  const available = connectors.filter((item) => !assignedIds.has(item.id));

  const pasteConnector =
    paste === null
      ? undefined
      : connectors.find((item) => item.id === paste.connectorId);

  const oauthConnector =
    oauthId === null
      ? undefined
      : connectors.find((item) => item.id === oauthId);

  const toolsRow =
    toolsId === null
      ? undefined
      : assignedRows.find((row) => row.connector.id === toolsId);

  return (
    <section className="flex max-w-3xl flex-col gap-4">
      {error !== undefined && (
        <p className="text-destructive text-sm">{error}</p>
      )}
      {assignedRows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No connectors assigned yet.
        </p>
      ) : (
        <ResponsiveTable>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>URL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Credential mode</TableHead>
              <TableHead>Tools</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {assignedRows.map(({ assignment, connector }) => (
              <AssignedConnectorRow
                agentId={agentId}
                assignment={assignment}
                connector={connector}
                key={connector.id}
                onChangeMode={changeMode}
                onChooseTools={openChooseTools}
                onPaste={openPaste}
                onRemove={removeConnector}
                onSetClient={openSetClient}
              />
            ))}
          </TableBody>
        </ResponsiveTable>
      )}
      <div className="flex flex-col gap-2">
        <p className="font-medium text-sm">Add a connector</p>
        {available.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No other connectors. Add one on the{" "}
            <Link to="/settings/connectors">Connectors page</Link>.
          </p>
        ) : (
          <div className="flex items-center gap-2">
            <NativeSelect
              aria-label="Connector to add"
              onChange={handleAddChange}
              value={addId}
            >
              <NativeSelectOption value="">
                Choose a connector
              </NativeSelectOption>
              {available.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <Button disabled={addId === ""} onClick={assignSelected}>
              Assign
            </Button>
          </div>
        )}
      </div>
      {pasteConnector !== undefined && (
        <PasteCredentialDialog
          agent={paste?.as === "agent" ? agentRef : undefined}
          connector={pasteConnector}
          onClose={closePaste}
          onSaved={pasteSaved}
        />
      )}
      {toolsRow !== undefined && (
        <AllowedToolsDialog
          agentId={agentId}
          allowedTools={toolsRow.assignment.allowedTools}
          connector={toolsRow.connector}
          credentialMode={toolsRow.assignment.credentialMode}
          onClose={closeChooseTools}
          onSaved={toolsSaved}
        />
      )}
      {oauthConnector !== undefined && (
        <OAuthClientDialog
          connector={oauthConnector}
          onClose={closeSetClient}
          onSaved={clientSaved}
        />
      )}
    </section>
  );
}
