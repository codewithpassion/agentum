import { useUser } from "@clerk/tanstack-react-start";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import type { Connector } from "#/lib/api";
import { cx } from "#/lib/cx";
import { useConnectorDetail, useConnectors } from "#/lib/use-connectors";
import { ConnectorDetail } from "./connector-detail";
import { ConnectorSetupDialog } from "./connector-setup-dialog";
import { ConnectorStatusDot } from "./connector-status";

/**
 * The connectors directory and one connector's detail, side by side - the same
 * shape as the wiki, which is the app's established "top-level section" layout.
 */

const rowClass = (active: boolean): string =>
  cx(
    "ws-focus flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] no-underline",
    active
      ? "bg-[var(--ws-surface-hover)] text-[var(--ws-text)]"
      : "text-[var(--ws-muted)] hover:bg-[var(--ws-surface)] hover:text-[var(--ws-text)]"
  );

function SignedOutNotice() {
  return (
    <div className="ws-shell items-center justify-center">
      <p className="m-0 text-[var(--ws-muted)] text-sm">
        <a className="text-[var(--ws-accent)]" href="/login">
          Sign in
        </a>{" "}
        to manage connectors.
      </p>
    </div>
  );
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="m-0 max-w-sm text-[var(--ws-muted)] text-sm">
        A connector is a remote MCP server your agents can use. Paste its URL
        and we work out what it needs to let you in.
      </p>
      <Button onClick={onAdd} variant="primary">
        Add connector
      </Button>
    </div>
  );
}

export function ConnectorsApp({ connectorId }: { connectorId: string | null }) {
  const { isSignedIn } = useUser();
  const signedIn = isSignedIn === true;
  const navigate = useNavigate();

  const { connectors, error: listError, reload } = useConnectors(signedIn);
  const {
    agents,
    connector,
    error: detailError,
    reload: reloadDetail,
  } = useConnectorDetail(connectorId, signedIn);

  /** Null while adding; a row while re-authorizing that row. */
  const [setup, setSetup] = useState<{ connector: Connector | null } | null>(
    null
  );

  const startAdd = useCallback(() => setSetup({ connector: null }), []);
  const startReauthorize = useCallback(
    (row: Connector) => setSetup({ connector: row }),
    []
  );
  const closeSetup = useCallback(() => setSetup(null), []);

  const refreshAll = useCallback(async () => {
    await reload();
    await reloadDetail();
  }, [reload, reloadDetail]);

  const onSetupDone = useCallback(
    async (row: Connector) => {
      await reload();
      await navigate({
        params: { connectorId: row.id },
        to: "/connectors/$connectorId",
      });
    },
    [navigate, reload]
  );

  const onRemoved = useCallback(async () => {
    await reload();
    await navigate({ to: "/connectors" });
  }, [navigate, reload]);

  if (isSignedIn === false) {
    return <SignedOutNotice />;
  }

  const error = listError ?? detailError;

  return (
    <div className="ws-shell">
      <nav
        aria-label="Connectors"
        className="flex w-70 shrink-0 flex-col border-[var(--ws-line)] border-r bg-[var(--ws-panel)]"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <Link className="font-semibold text-sm no-underline" to="/">
            ← Agentum
          </Link>
          <Button
            aria-label="Add connector"
            onClick={startAdd}
            size="icon"
            title="Add connector"
            variant="ghost"
          >
            <span aria-hidden="true">＋</span>
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3">
          <h2 className="px-2 pt-1 pb-2 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
            Connectors
          </h2>
          {connectors.length === 0 ? (
            <p className="m-0 px-2 py-1 text-[var(--ws-muted)] text-xs">
              No connectors yet.
            </p>
          ) : null}
          {connectors.map((row) => (
            <Link
              className={rowClass(row.id === connectorId)}
              key={row.id}
              params={{ connectorId: row.id }}
              to="/connectors/$connectorId"
            >
              <ConnectorStatusDot status={row.status} />
              <span className="truncate">{row.name}</span>
            </Link>
          ))}
        </div>
      </nav>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {connector ? (
          <ConnectorDetail
            agents={agents}
            connector={connector}
            onChanged={refreshAll}
            onReauthorize={startReauthorize}
            onRemoved={onRemoved}
          />
        ) : (
          <EmptyState onAdd={startAdd} />
        )}
      </main>

      {error ? (
        <p className="fixed bottom-3 left-3 m-0 rounded-lg bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-danger)] text-xs">
          {error}
        </p>
      ) : null}

      <ConnectorSetupDialog
        connector={setup?.connector ?? null}
        onClose={closeSetup}
        onDone={onSetupDone}
        open={setup !== null}
      />
    </div>
  );
}
