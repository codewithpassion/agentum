import { useCallback, useState } from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { ConfirmDialog } from "#/components/workspace/confirm-dialog";
import {
  type Connector,
  type ConnectorAgentRef,
  removeConnector,
  setConnectorDisabled,
  testConnector,
} from "#/lib/api";
import { ConnectorStatusLine } from "./connector-status";

/**
 * Everything about one connector on one screen (plan 4d): how it stands, what
 * it can do, who may use it, and the four things a human can do to it.
 */

/** Said in both places it matters: the picker and the list of who has it. */
export const NEXT_SESSION_NOTE =
  "Assignment changes take effect on the agent's next session - a running session keeps the credentials it started with.";

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

function ToolList({ connector }: { connector: Connector }) {
  const tools = connector.toolCache ? connector.toolCache.tools : [];
  if (tools.length === 0) {
    return (
      <Notice tone="muted">
        No tools listed yet. Run "Test connection" once this connector is
        authorized.
      </Notice>
    );
  }

  return (
    <ul className="m-0 list-none space-y-1 p-0" data-testid="connector-tools">
      {tools.map((tool) => (
        <li
          className="rounded-lg border border-[var(--ws-line)] px-3 py-2"
          key={tool.name}
        >
          <span className="font-mono text-[13px]">{tool.name}</span>
          {tool.description ? (
            <span className="block text-[var(--ws-muted)] text-xs">
              {tool.description}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function AssignedAgents({ agents }: { agents: ConnectorAgentRef[] }) {
  if (agents.length === 0) {
    return (
      <Notice tone="muted">
        No agents yet. Assign this connector from an agent's settings.
      </Notice>
    );
  }

  return (
    <>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {agents.map((agent) => (
          <li
            className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--ws-line)] px-2 py-1 text-xs"
            key={agent.id}
          >
            <Avatar color={agent.avatar} name={agent.name} size="sm" />
            <span>{agent.name}</span>
          </li>
        ))}
      </ul>
      <p className="m-0 text-[var(--ws-muted)] text-xs">{NEXT_SESSION_NOTE}</p>
    </>
  );
}

export function ConnectorDetail({
  agents,
  connector,
  onChanged,
  onReauthorize,
  onRemoved,
}: {
  agents: ConnectorAgentRef[];
  connector: Connector;
  onChanged: () => Promise<void>;
  onReauthorize: (connector: Connector) => void;
  onRemoved: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<string | null>(null);
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
    setTestMessage(null);
    run(async () => {
      const { result } = await testConnector(connector.id);
      setTestMessage(
        result.ok
          ? `Reached the server: ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}.`
          : (result.message ?? "The server did not answer.")
      );
      await onChanged();
    });
  }, [connector.id, onChanged, run]);

  const toggleDisabled = useCallback(() => {
    run(async () => {
      await setConnectorDisabled(connector.id, connector.status !== "disabled");
      await onChanged();
    });
  }, [connector.id, connector.status, onChanged, run]);

  const reauthorize = useCallback(
    () => onReauthorize(connector),
    [connector, onReauthorize]
  );

  const askRemove = useCallback(() => setRemoveOpen(true), []);
  const cancelRemove = useCallback(() => setRemoveOpen(false), []);
  const confirmRemove = useCallback(async () => {
    await removeConnector(connector.id);
    setRemoveOpen(false);
    await onRemoved();
  }, [connector.id, onRemoved]);

  const disabled = connector.status === "disabled";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <header className="space-y-2">
          <h2 className="m-0 font-semibold text-lg">{connector.name}</h2>
          <p className="m-0 break-all font-mono text-[var(--ws-muted)] text-xs">
            {connector.url}
          </p>
          <ConnectorStatusLine connector={connector} />
        </header>

        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={test}>
            Test connection
          </Button>
          <Button disabled={busy} onClick={reauthorize}>
            Re-authorize
          </Button>
          <Button disabled={busy} onClick={toggleDisabled}>
            {disabled ? "Enable" : "Disable"}
          </Button>
          <Button disabled={busy} onClick={askRemove} variant="danger">
            Remove
          </Button>
        </div>

        {testMessage ? <Notice tone="muted">{testMessage}</Notice> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        {connector.lastError ? (
          <Notice tone="danger">{connector.lastError}</Notice>
        ) : null}
        {connector.needsManagementReauth ? (
          <Notice tone="muted">
            Re-authorize for management features. Listing tools and testing the
            connection stopped working, most likely because the server rotated
            our refresh token - sessions already using this connector are
            unaffected.
          </Notice>
        ) : null}

        <Section title="Tools">
          <ToolList connector={connector} />
        </Section>

        <Section title="Agents">
          <AssignedAgents agents={agents} />
        </Section>
      </div>

      <ConfirmDialog
        confirmLabel="Remove connector"
        message={`Remove ${connector.name}? Its stored credential is archived in the Anthropic vault and deleted here, and every agent using it is resynced without it.`}
        onCancel={cancelRemove}
        onConfirm={confirmRemove}
        open={removeOpen}
        title="Remove connector"
      />
    </div>
  );
}
