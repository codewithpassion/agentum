import { useAuth } from "@clerk/tanstack-react-start";
import type {
  AgentKeyApp,
  CatalogEntry,
  CredentialMode,
} from "@repo/db/shared";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { canManageAgentKeys } from "#/components/agent/agent-rights.ts";
import { AllowedToolsDialog } from "#/components/connectors/allowed-tools-dialog";
import { PasteCredentialDialog } from "#/components/connectors/paste-credential-dialog";
import { getTrpc } from "#/integrations/trpc/client";
import type {
  AgentRecord,
  ConnectorRecord,
  RouterOutputs,
} from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";
import { AddApp } from "./add-app.tsx";
import { AppRow } from "./app-row.tsx";
import { isSecretBacked } from "./keys-logic.ts";

type MySignIn = RouterOutputs["connectors"]["mine"][number];

interface Loaded {
  /** Null when the catalogue could not be read. */
  catalog: CatalogEntry[] | null;
  connectors: ConnectorRecord[];
  mine: MySignIn[];
}

/**
 * "Apps it can use": each app the agent may call, whose sign-in it uses, and
 * what a person can do about it. The rows come from `keys.forAgent`. The
 * person's own sign-ins (`connectors.mine`), the full connectors the dialogs
 * need and the catalogue load here, because the read model carries none of them.
 */
export function AppsSection({
  agent,
  apps,
}: {
  agent: AgentRecord;
  apps: AgentKeyApp[];
}) {
  const { orgRole, userId } = useAuth();
  const isAdmin = orgRole === "org:admin";
  const canManage = canManageAgentKeys({ agent, isAdmin, userId });
  const router = useRouter();
  const agentId = agent.id;
  const agentRef = useMemo(
    () => ({ id: agentId, name: agent.name }),
    [agentId, agent.name]
  );
  const [loaded, setLoaded] = useState<Loaded | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [toolsId, setToolsId] = useState<string | null>(null);
  const [paste, setPaste] = useState<{
    as: "me" | "agent";
    connectorId: string;
  } | null>(null);

  const fetchLoaded = useCallback(async (): Promise<Loaded> => {
    const [mine, connectors, catalog] = await Promise.all([
      getTrpc().connectors.mine.query(),
      getTrpc().connectors.list.query(),
      // A failed catalogue read hides the catalogue and blocks adding catalogue
      // connectors (their default tools are unknown), but not the rows.
      getTrpc()
        .catalog.list.query()
        .catch((): CatalogEntry[] | null => null),
    ]);
    return { catalog, connectors, mine };
  }, []);

  useEffect(() => {
    let active = true;
    fetchLoaded()
      .then((next) => {
        if (active) {
          setLoaded(next);
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
  }, [fetchLoaded]);

  // The rows come from the page data, the rest from here: refresh both.
  const reload = useCallback(async () => {
    try {
      setLoaded(await fetchLoaded());
      setError(undefined);
      await router.invalidate();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [fetchLoaded, router]);

  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (cause) {
        setError(errorMessage(cause));
        return;
      }
      await reload();
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

  const removeApp = useCallback(
    (connectorId: string) =>
      act(() => getTrpc().connectors.unassign.mutate({ agentId, connectorId })),
    [act, agentId]
  );

  const openPaste = useCallback(
    (connectorId: string, as: "me" | "agent") => setPaste({ as, connectorId }),
    []
  );
  const closePaste = useCallback(() => setPaste(null), []);
  const pasteSaved = useCallback(() => {
    setPaste(null);
    return reload();
  }, [reload]);

  const closeTools = useCallback(() => setToolsId(null), []);
  const toolsSaved = useCallback(() => {
    setToolsId(null);
    return reload();
  }, [reload]);

  const assignedIds = useMemo(
    () => new Set(apps.map((app) => app.connectorId)),
    [apps]
  );
  const connectorOf = (id: string | null): ConnectorRecord | undefined =>
    id === null
      ? undefined
      : loaded?.connectors.find((connector) => connector.id === id);
  // Only the agent's owners and admins change its apps. A member cannot
  // change an app that runs on a workspace secret.
  const canEdit = (connector: ConnectorRecord | undefined): boolean =>
    canManage &&
    (isAdmin || connector === undefined || !isSecretBacked(connector));
  const toolsApp = apps.find((app) => app.connectorId === toolsId);
  const toolsConnector = connectorOf(toolsId);
  const pasteConnector = connectorOf(paste?.connectorId ?? null);

  return (
    <div className="flex flex-col gap-4">
      {error === undefined ? null : (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      )}
      {apps.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No apps yet. Add one below so this agent can use it.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {apps.map((app) => (
            <AppRow
              agentId={agentId}
              app={app}
              canEdit={canEdit(connectorOf(app.connectorId))}
              canSetCredential={canManage}
              connector={connectorOf(app.connectorId)}
              isAdmin={isAdmin}
              key={app.connectorId}
              mine={loaded?.mine.find((item) => item.id === app.connectorId)}
              onChangeMode={changeMode}
              onChooseTools={setToolsId}
              onPaste={openPaste}
              onRemove={removeApp}
            />
          ))}
        </ul>
      )}
      {loaded === undefined ? null : (
        <AddApp
          agentId={agentId}
          assignedIds={assignedIds}
          catalog={loaded.catalog}
          connectors={loaded.connectors}
          disabled={!canManage}
          isAdmin={isAdmin}
          onAdded={reload}
        />
      )}
      {paste !== null && pasteConnector !== undefined && (
        <PasteCredentialDialog
          agent={paste.as === "agent" ? agentRef : undefined}
          connector={pasteConnector}
          onClose={closePaste}
          onSaved={pasteSaved}
        />
      )}
      {toolsApp !== undefined && toolsConnector !== undefined && (
        <AllowedToolsDialog
          agentId={agentId}
          allowedTools={toolsApp.allowedTools}
          connector={toolsConnector}
          credentialMode={toolsApp.credentialMode}
          onClose={closeTools}
          onSaved={toolsSaved}
        />
      )}
    </div>
  );
}
