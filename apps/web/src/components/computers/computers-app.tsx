import { useUser } from "@clerk/tanstack-react-start";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import type { ComputerHost } from "#/lib/api";
import { COMPUTER_HOST_KIND_LABELS, lastSeenLabel } from "#/lib/computer-hosts";
import { cx } from "#/lib/cx";
import { useComputerHosts } from "#/lib/use-computer-hosts";
import { useWorkspaceData } from "#/lib/use-workspace-data";
import { useActiveWorkspace, useWorkspaceSlug } from "#/lib/workspace-context";
import { ComputerHostDetail } from "./computer-host-detail";
import { ComputerHostDialog } from "./computer-host-dialog";
import { ComputerHostStatusDot } from "./computer-host-status";

/**
 * The computer hosts directory and one host's page, side by side - the same
 * shape as connectors and the wiki, which is the app's "top-level section"
 * layout.
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
        to manage computers.
      </p>
    </div>
  );
}

function EmptyState({
  canManage,
  onAdd,
}: {
  canManage: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="m-0 max-w-sm text-[var(--ws-muted)] text-sm">
        A computer host is where an agent's files and shell live when they do
        not live on Cloudflare: a Fly.io app, or a container on your own
        hardware. Both give an agent a real Linux shell in production.
      </p>
      {canManage ? (
        <Button onClick={onAdd} variant="primary">
          Add host
        </Button>
      ) : null}
    </div>
  );
}

export function ComputersApp({ hostId }: { hostId: string | null }) {
  const workspaceSlug = useWorkspaceSlug();
  const { membership } = useActiveWorkspace();
  const canManage = membership?.role === "owner";

  const { isSignedIn } = useUser();
  const signedIn = isSignedIn === true;
  const navigate = useNavigate();

  const { error: listError, hosts, reload } = useComputerHosts(signedIn);
  const { agents } = useWorkspaceData(signedIn);
  const [addOpen, setAddOpen] = useState(false);

  const openAdd = useCallback(() => setAddOpen(true), []);
  const closeAdd = useCallback(() => setAddOpen(false), []);

  const onAdded = useCallback(
    async (added: ComputerHost) => {
      await reload();
      await navigate({
        params: { hostId: added.id, workspaceSlug },
        to: "/w/$workspaceSlug/computers/$hostId",
      });
    },
    [navigate, reload, workspaceSlug]
  );

  const onRemoved = useCallback(async () => {
    await reload();
    await navigate({
      params: { workspaceSlug },
      to: "/w/$workspaceSlug/computers",
    });
  }, [navigate, reload, workspaceSlug]);

  if (isSignedIn === false) {
    return <SignedOutNotice />;
  }

  const host = hosts.find((row) => row.id === hostId) ?? null;

  return (
    <div className="ws-shell">
      <nav
        aria-label="Computers"
        className="flex w-70 shrink-0 flex-col border-[var(--ws-line)] border-r bg-[var(--ws-panel)]"
      >
        <div className="flex items-center justify-between gap-2 px-3 py-3">
          <Link
            className="font-semibold text-sm no-underline"
            params={{ workspaceSlug }}
            to="/w/$workspaceSlug"
          >
            ← Agentum
          </Link>
          {canManage ? (
            <Button
              aria-label="Add computer host"
              onClick={openAdd}
              size="icon"
              title="Add computer host"
              variant="ghost"
            >
              <span aria-hidden="true">＋</span>
            </Button>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3">
          <h2 className="px-2 pt-1 pb-2 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
            Computers
          </h2>
          {hosts.length === 0 ? (
            <p className="m-0 px-2 py-1 text-[var(--ws-muted)] text-xs">
              No computer hosts yet.
            </p>
          ) : null}
          {hosts.map((row) => (
            <Link
              className={rowClass(row.id === hostId)}
              key={row.id}
              params={{ hostId: row.id, workspaceSlug }}
              title={`${COMPUTER_HOST_KIND_LABELS[row.kind]} · ${lastSeenLabel(row.lastSeenAt)}`}
              to="/w/$workspaceSlug/computers/$hostId"
            >
              <ComputerHostStatusDot status={row.status} />
              <span className="truncate">{row.name}</span>
              <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide">
                {row.kind === "fly" ? "fly" : "self"}
              </span>
              <span className="shrink-0 text-[10px] text-[var(--ws-muted)]">
                {lastSeenLabel(row.lastSeenAt)}
              </span>
            </Link>
          ))}
        </div>
      </nav>

      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {host ? (
          <ComputerHostDetail
            agents={agents}
            canManage={canManage}
            host={host}
            // Switching hosts must not carry the previous one's rotated token,
            // test result or error onto this page.
            key={host.id}
            onChanged={reload}
            onRemoved={onRemoved}
          />
        ) : (
          <EmptyState canManage={canManage} onAdd={openAdd} />
        )}
      </main>

      {listError ? (
        <p className="fixed bottom-3 left-3 m-0 rounded-lg bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-danger)] text-xs">
          {listError}
        </p>
      ) : null}

      <ComputerHostDialog onClose={closeAdd} onDone={onAdded} open={addOpen} />
    </div>
  );
}
