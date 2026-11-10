import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { formatDistanceToNow } from "date-fns";
import { type ReactNode, useCallback, useState } from "react";
import { ConfirmButton } from "#/components/confirm-action/confirm-button";
import { ConnectionTasks } from "#/components/connections/connection-tasks";
import {
  isEnded,
  kindWords,
  peerHost,
  peerName,
  revokeWords,
  statusWords,
} from "#/components/connections/connections-logic";
import { PoliciesPanel } from "#/components/connections/policies-panel";
import { Badge } from "#/components/ui/badge";
import { Button, buttonVariants } from "#/components/ui/button";
import { getTrpc } from "#/integrations/trpc/client";
import { loadOrLogin } from "#/integrations/trpc/load-or-login";
import type { RouterOutputs } from "#/integrations/trpc/types";
import { errorMessage } from "#/lib/error-message";

type Connection = RouterOutputs["a2a"]["get"];

const CHECK_CODE_STATUSES: string[] = [
  "needs_approval",
  "awaiting_peer",
  "activating",
];

export const Route = createFileRoute(
  "/_app/settings/agent-connections/$connectionId"
)({
  loader: async ({ params }) =>
    loadOrLogin(async () => {
      const { connectionId } = params;
      const trpc = getTrpc();
      const [connection, manage, tasks] = await Promise.all([
        trpc.a2a.get.query({ connectionId }),
        trpc.a2a.manage.query({ connectionId }),
        trpc.a2a.recentTasks.query({ connectionId }),
      ]);
      return { connection, manage, tasks };
    }),
  component: ConnectionPage,
});

const ago = (time: string): string =>
  formatDistanceToNow(new Date(time), { addSuffix: true });

function Fact({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-all text-foreground text-sm">{children}</dd>
    </div>
  );
}

function ConnectionHeader({
  connection,
  revokedBy,
}: {
  connection: Connection;
  revokedBy: string | null;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Link
        className={buttonVariants({
          className: "self-start px-0",
          size: "sm",
          variant: "link",
        })}
        to="/settings/agent-connections"
      >
        Back to connections
      </Link>
      <h1 className="font-heading text-3xl text-foreground">
        <span className="break-words">{peerName(connection)}</span>
      </h1>
      <p className="text-muted-foreground text-sm">
        {peerHost(connection) ?? "No address known"}
      </p>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <Badge variant="outline">{statusWords(connection.status)}</Badge>
        <span className="text-muted-foreground">
          {kindWords(connection.peerKind)}
        </span>
      </div>
      {connection.peerOrg === null ? null : (
        <p className="text-sm">Claims to be {connection.peerOrg}</p>
      )}
      <dl className="grid gap-4 sm:grid-cols-2">
        <Fact label="My agent">
          <Link
            className="underline underline-offset-4"
            params={{ agentId: connection.agentId }}
            to="/agents/$agentId"
          >
            {connection.agentName}
          </Link>
        </Fact>
        <Fact label="Created">{ago(connection.createdAt)}</Fact>
        {connection.approvedAt === null ? null : (
          <Fact label="Approved">{ago(connection.approvedAt)}</Fact>
        )}
        {connection.revokedAt === null ? null : (
          <Fact label="Revoked">
            {ago(connection.revokedAt)}
            {revokedBy === null ? "" : ` by ${revokedBy}`}
          </Fact>
        )}
        {connection.peerKind === "a2a_outbound" &&
        connection.peerCardUrl !== null ? (
          <Fact label="Card URL">
            <span className="font-mono text-xs">{connection.peerCardUrl}</span>
          </Fact>
        ) : null}
        {connection.peerKind === "a2a_inbound" &&
        connection.tokenPrefix !== null ? (
          <Fact label="Key">Key starts with {connection.tokenPrefix}</Fact>
        ) : null}
      </dl>
    </div>
  );
}

function ApprovalCard({
  busy,
  connection,
  onApprove,
  onDecline,
  reason,
}: {
  busy: boolean;
  connection: Connection;
  onApprove: () => void;
  onDecline: () => void;
  reason: string | null;
}) {
  const host = peerHost(connection);
  const origin = connection.pendingOrigin ?? connection.peerOrigin;
  const tokenUrl = connection.pendingTokenUrl ?? connection.tokenUrl;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-heading text-foreground text-xl">Approval</h2>
      {host === null ? (
        <p className="text-sm">This peer has no address to approve.</p>
      ) : (
        <p className="text-sm">Approve {host}</p>
      )}
      {origin === null ? null : (
        <p className="break-all font-mono text-muted-foreground text-xs">
          {origin}
        </p>
      )}
      {tokenUrl === null ? null : (
        <p className="break-all text-sm">
          The client secret goes to{" "}
          <span className="font-mono text-xs">{tokenUrl}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={busy || reason !== null || origin === null}
          onClick={onApprove}
        >
          Approve
        </Button>
        <Button disabled={busy} onClick={onDecline} variant="outline">
          Decline
        </Button>
        {reason === null ? null : (
          <p className="text-muted-foreground text-sm">{reason}</p>
        )}
      </div>
    </section>
  );
}

function ConnectionPage() {
  const { connection, manage, tasks } = Route.useLoaderData();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { id: connectionId } = connection;
  const origin = connection.pendingOrigin ?? connection.peerOrigin;
  const tokenUrl = connection.pendingTokenUrl ?? connection.tokenUrl;

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await router.invalidate();
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusy(false);
      }
    },
    [router]
  );

  const reload = useCallback(async () => {
    await router.invalidate();
  }, [router]);

  const approve = useCallback(async () => {
    if (origin === null) {
      return;
    }
    await runAction(() =>
      getTrpc().a2a.approve.mutate({
        connectionId,
        seen: { origin, tokenUrl },
      })
    );
  }, [connectionId, origin, runAction, tokenUrl]);

  const decline = useCallback(async () => {
    await runAction(() => getTrpc().a2a.decline.mutate({ connectionId }));
  }, [connectionId, runAction]);

  const revoke = useCallback(async () => {
    await runAction(() => getTrpc().a2a.revoke.mutate({ connectionId }));
  }, [connectionId, runAction]);

  const refreshCard = useCallback(async () => {
    await runAction(() => getTrpc().a2a.refreshCard.mutate({ connectionId }));
  }, [connectionId, runAction]);

  const showCheckCode =
    connection.checkCode !== null &&
    CHECK_CODE_STATUSES.includes(connection.status);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-8">
      <ConnectionHeader connection={connection} revokedBy={manage.revokedBy} />

      {showCheckCode ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-heading text-foreground text-xl">Check code</h2>
          <p className="font-mono text-4xl text-foreground tracking-widest">
            {connection.checkCode}
          </p>
          <p className="text-muted-foreground text-sm">
            Compare this code with the other side if the link went through
            anything you do not trust.
          </p>
        </section>
      ) : null}

      {connection.status === "needs_approval" ? (
        <ApprovalCard
          busy={busy}
          connection={connection}
          onApprove={approve}
          onDecline={decline}
          reason={manage.reason}
        />
      ) : null}

      <section className="flex flex-col gap-4">
        <h2 className="font-heading text-foreground text-xl">Policies</h2>
        <PoliciesPanel
          connection={connection}
          manageReason={manage.reason}
          onChanged={reload}
        />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="font-heading text-foreground text-xl">
          Recent messages
        </h2>
        <ConnectionTasks tasks={tasks} />
      </section>

      {connection.peerKind === "a2a_outbound" && !isEnded(connection.status) ? (
        <section className="flex flex-col gap-2">
          <h2 className="font-heading text-foreground text-xl">Agent card</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={busy} onClick={refreshCard} variant="outline">
              Refresh
            </Button>
            <p className="text-muted-foreground text-sm">
              Fetch the agent&apos;s card again. If it moved to another address
              you will be asked to approve it.
            </p>
          </div>
        </section>
      ) : null}

      {isEnded(connection.status) ? null : (
        <section className="flex flex-col gap-2">
          <h2 className="font-heading text-foreground text-xl">Revoke</h2>
          <div>
            <ConfirmButton
              description={revokeWords(connection)}
              disabled={busy}
              onConfirm={revoke}
              size="sm"
              title="Revoke connection?"
              variant="outline"
            >
              Revoke
            </ConfirmButton>
          </div>
        </section>
      )}

      {error === null ? null : (
        <p className="text-destructive text-sm">{error}</p>
      )}
    </section>
  );
}
