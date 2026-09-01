import { useCallback, useState } from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import type { Agent, ComputerHost } from "#/lib/api";
import {
  COMPUTER_HOST_KIND_LABELS,
  COMPUTERD_IMAGE,
  hostRemovalBlock,
} from "#/lib/computer-hosts";
import { formatDay } from "#/lib/format";
import { useApi } from "#/lib/workspace-context";
import { ComputerHostStatusLine } from "./computer-host-status";
import { ComputerTokenPanel } from "./computer-token-panel";

/**
 * Everything about one computer host on one screen: how it stands, what it is
 * made of, who runs on it, and the three things an owner can do to it. Writes
 * are owner-gated on the server, so a member sees the same facts without the
 * buttons.
 */

const messageOf = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

function Section({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Notice({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "danger" | "muted";
}) {
  return (
    <p
      className="m-0 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 text-xs"
      style={{
        color: tone === "danger" ? "var(--ws-danger)" : "var(--ws-muted)",
      }}
    >
      {children}
    </p>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-[var(--ws-line)] border-b py-1.5 last:border-b-0">
      <span className="text-[var(--ws-muted)] text-xs">{label}</span>
      <span className="truncate text-right text-[13px]">{value}</span>
    </div>
  );
}

function HostFacts({ host }: { host: ComputerHost }) {
  if (host.kind === "fly") {
    const { app, instance, region, volume_gb } = host.config;
    return (
      <div>
        <Fact label="Kind" value={COMPUTER_HOST_KIND_LABELS.fly} />
        <Fact label="App" value={app ?? "—"} />
        <Fact label="Region" value={region ?? "Fly's choice"} />
        <Fact
          label="Machine"
          value={`${instance?.cpus ?? 1} CPU · ${instance?.memory_mb ?? 512} MB`}
        />
        <Fact label="Volume per agent" value={`${volume_gb ?? 10} GB`} />
        <Fact
          label="Fly API token"
          value={host.flyApiTokenHint ? `••••${host.flyApiTokenHint}` : "—"}
        />
        <Fact
          label="Added"
          value={formatDay(new Date(host.createdAt).getTime())}
        />
      </div>
    );
  }

  return (
    <div>
      <Fact label="Kind" value={COMPUTER_HOST_KIND_LABELS.self_hosted} />
      <Fact label="Image" value={COMPUTERD_IMAGE} />
      <Fact label="Agents" value={host.agentIds.length === 0 ? "none" : "1"} />
      <Fact
        label="Added"
        value={formatDay(new Date(host.createdAt).getTime())}
      />
    </div>
  );
}

function HostAgents({ agents, host }: { agents: Agent[]; host: ComputerHost }) {
  if (host.agentIds.length === 0) {
    return (
      <Notice tone="muted">
        No agents run here yet. Pick this host when you create an agent — where
        a computer runs is fixed at creation.
      </Notice>
    );
  }

  return (
    <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
      {host.agentIds.map((agentId) => {
        const agent = agents.find((candidate) => candidate.id === agentId);
        return (
          <li
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ws-line)] px-2 py-1 text-xs"
            key={agentId}
          >
            {agent ? (
              <Avatar color={agent.avatar} name={agent.name} size="sm" />
            ) : null}
            {/* An id the agents list has not caught up with is still worth naming. */}
            <span>{agent?.name ?? agentId}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function ComputerHostDetail({
  agents,
  canManage,
  host,
  onChanged,
  onRemoved,
}: {
  agents: Agent[];
  /** An owner may test, rotate and remove; everyone else only reads. */
  canManage: boolean;
  host: ComputerHost;
  onChanged: () => Promise<void>;
  onRemoved: () => Promise<void>;
}) {
  const api = useApi();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rotated, setRotated] = useState<string | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(messageOf(cause, "That did not work."));
    } finally {
      setBusy(false);
    }
  }, []);

  const test = useCallback(() => {
    setNote(null);
    run(async () => {
      const result = await api.testComputerHost(host.id);
      setNote(
        result.ok
          ? `Answered: computerd ${result.version ?? "?"} on ${result.hostname ?? "the host"}.`
          : (result.reason ?? "The host did not answer.")
      );
      await onChanged();
    });
  }, [api, host.id, onChanged, run]);

  const rotate = useCallback(() => {
    setNote(null);
    setRotated(null);
    run(async () => {
      const issued = await api.updateComputerHost(host.id, {
        rotateToken: true,
      });
      // Fly hosts hold their own token; there is nothing for a person to copy.
      if (issued.token) {
        setRotated(issued.token);
      } else {
        setNote(
          "Rotated. Fly machines pick up the new token on the next call."
        );
      }
      await onChanged();
    });
  }, [api, host.id, onChanged, run]);

  const askRemove = useCallback(() => setRemoveOpen(true), []);
  const cancelRemove = useCallback(() => setRemoveOpen(false), []);
  const confirmRemove = useCallback(async () => {
    await api.deleteComputerHost(host.id);
    setRemoveOpen(false);
    await onRemoved();
  }, [api, host.id, onRemoved]);

  const removalBlock = hostRemovalBlock(host);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-2">
          <h2 className="m-0 font-semibold text-lg">{host.name}</h2>
          <ComputerHostStatusLine host={host} />
        </header>

        {canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={test}>
              Test connection
            </Button>
            <Button disabled={busy} onClick={rotate}>
              Rotate token
            </Button>
            <Button
              disabled={busy || removalBlock !== null}
              onClick={askRemove}
              title={removalBlock ?? undefined}
              variant="danger"
            >
              Remove
            </Button>
          </div>
        ) : (
          <Notice tone="muted">
            Only an owner can test, rotate or remove a computer host.
          </Notice>
        )}

        {removalBlock && canManage ? (
          <Notice tone="muted">{removalBlock}</Notice>
        ) : null}
        {note ? <Notice tone="muted">{note}</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {host.statusError ? (
          <Notice tone="danger">{host.statusError}</Notice>
        ) : null}

        {rotated ? (
          <Section title="New token">
            <Notice tone="muted">
              The container is disconnected until it is restarted with this
              token. Stop the old one (
              <code>docker rm -f agentum-computer</code>) and run:
            </Notice>
            <ComputerTokenPanel token={rotated} />
          </Section>
        ) : null}

        <Section title="Details">
          <HostFacts host={host} />
        </Section>

        <Section title="Agents">
          <HostAgents agents={agents} host={host} />
        </Section>

        {host.kind === "self_hosted" ? (
          <Section title="Trust">
            <Notice tone="muted">
              This container runs whatever the agent decides to run, with the
              network access the container has. The container boundary is the
              safety: give it its own volume, keep the memory and CPU caps, and
              put it on a machine and a network you are willing to hand to a
              program.
            </Notice>
          </Section>
        ) : null}
      </div>

      <ConfirmDialog
        confirmLabel="Remove host"
        message={`Remove ${host.name}? Agentum forgets its credentials. ${host.kind === "fly" ? "Machines and volumes already in the Fly app are not deleted." : "Stop the container yourself; it will keep trying to reconnect."}`}
        onCancel={cancelRemove}
        onConfirm={confirmRemove}
        open={removeOpen}
        title="Remove computer host"
      />
    </div>
  );
}
