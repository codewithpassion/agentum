import type { ChangeEvent } from "react";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "#/components/ui/button";
import { TextField } from "#/components/ui/field";
import { Popover } from "#/components/ui/popover";
import {
  type Agent,
  type ChannelBridge,
  type ConnectorStatus,
  deleteChannelBridge,
  getChannelBridge,
  saveChannelBridge,
} from "#/lib/api";

/**
 * The channel's settings pane, reachable from the channel header - bridging a
 * channel to Slack is done here and nowhere else, no deep link required.
 */

type BridgeState =
  | { status: "error"; message: string }
  | { status: "loading" }
  | {
      bridge: ChannelBridge | null;
      connector: ConnectorStatus;
      status: "ready";
    };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

function NotConfigured({ missing }: { missing: string[] }) {
  return (
    <p
      className="m-0 text-[var(--ws-muted)] text-xs leading-5"
      data-testid="slack-not-configured"
    >
      Slack not configured — set {missing.join(" & ")} in{" "}
      <code className="text-[11px]">apps/web/.env.local</code> and restart the
      dev server.
    </p>
  );
}

function BridgeStatus({
  agents,
  bridge,
  busy,
  onDisconnect,
}: {
  agents: Agent[];
  bridge: ChannelBridge;
  busy: boolean;
  onDisconnect: () => void;
}) {
  const agent = agents.find((candidate) => candidate.id === bridge.agentId);

  return (
    <div className="space-y-2" data-testid="slack-bridge-status">
      <p className="m-0 text-[13px]">
        Connected to Slack channel{" "}
        <code className="text-[11px]">{bridge.externalChannelId}</code>
      </p>
      <p className="m-0 text-[var(--ws-muted)] text-xs">
        {agent
          ? `The bot speaks as ${agent.name}; mentioning it in Slack wakes ${agent.name}.`
          : "No agent is mapped, so a Slack mention of the bot reaches nobody."}
      </p>
      <Button disabled={busy} onClick={onDisconnect} size="sm" variant="danger">
        Disconnect
      </Button>
    </div>
  );
}

function BridgeForm({
  agents,
  busy,
  onConnect,
}: {
  agents: Agent[];
  busy: boolean;
  onConnect: (input: {
    agentId: string | null;
    externalChannelId: string;
  }) => void;
}) {
  const agentSelectId = useId();
  const [externalChannelId, setExternalChannelId] = useState("");
  const [agentId, setAgentId] = useState("");

  const submit = useCallback(() => {
    onConnect({ agentId: agentId || null, externalChannelId });
  }, [agentId, externalChannelId, onConnect]);

  const changeChannelId = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setExternalChannelId(event.target.value),
    []
  );

  const changeAgent = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setAgentId(event.target.value),
    []
  );

  return (
    <div className="space-y-3" data-testid="slack-bridge-form">
      <TextField
        data-testid="slack-channel-id"
        hint="From the channel's About tab in Slack, e.g. C0123ABCDEF."
        label="Slack channel ID"
        onChange={changeChannelId}
        placeholder="C0123ABCDEF"
        value={externalChannelId}
      />
      <div className="space-y-1.5">
        <label
          className="block font-medium text-[var(--ws-muted)] text-xs"
          htmlFor={agentSelectId}
        >
          The bot speaks as
        </label>
        <select
          className="ws-focus w-full rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-text)] text-sm"
          data-testid="slack-bridge-agent"
          id={agentSelectId}
          onChange={changeAgent}
          value={agentId}
        >
          <option value="">Nobody — mirror messages only</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
      </div>
      <Button
        disabled={busy || externalChannelId.trim().length === 0}
        onClick={submit}
        size="sm"
        variant="primary"
      >
        Connect
      </Button>
    </div>
  );
}

export function ChannelSettings({
  agents,
  channelId,
}: {
  agents: Agent[];
  channelId: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BridgeState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const data = await getChannelBridge(channelId);
      setState({ ...data, status: "ready" });
    } catch (error) {
      setState({ message: errorMessage(error), status: "error" });
    }
  }, [channelId]);

  useEffect(() => {
    if (open) {
      setActionError(null);
      load();
    }
  }, [load, open]);

  const toggle = useCallback(() => setOpen((current) => !current), []);
  const close = useCallback(() => setOpen(false), []);

  const connect = useCallback(
    (input: { agentId: string | null; externalChannelId: string }) => {
      (async () => {
        setBusy(true);
        setActionError(null);
        try {
          await saveChannelBridge(channelId, input);
          await load();
        } catch (error) {
          setActionError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      })();
    },
    [channelId, load]
  );

  const disconnect = useCallback(() => {
    (async () => {
      setBusy(true);
      setActionError(null);
      try {
        await deleteChannelBridge(channelId);
        await load();
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [channelId, load]);

  return (
    <div className="relative">
      <Button
        aria-expanded={open}
        data-testid="channel-settings-button"
        onClick={toggle}
        size="sm"
        variant="ghost"
      >
        Settings
      </Button>
      <Popover align="right" className="w-80 p-4" onClose={close} open={open}>
        <section className="space-y-3" data-testid="channel-settings">
          <h2 className="m-0 font-semibold text-[13px]">Connect to Slack</h2>
          <SlackSection
            agents={agents}
            busy={busy}
            onConnect={connect}
            onDisconnect={disconnect}
            state={state}
          />
          {actionError ? (
            <p
              className="m-0 text-[var(--ws-danger)] text-xs"
              data-testid="channel-settings-error"
            >
              {actionError}
            </p>
          ) : null}
        </section>
      </Popover>
    </div>
  );
}

function SlackSection({
  agents,
  busy,
  onConnect,
  onDisconnect,
  state,
}: {
  agents: Agent[];
  busy: boolean;
  onConnect: (input: {
    agentId: string | null;
    externalChannelId: string;
  }) => void;
  onDisconnect: () => void;
  state: BridgeState;
}) {
  if (state.status === "loading") {
    return <p className="m-0 text-[var(--ws-muted)] text-xs">Loading…</p>;
  }
  if (state.status === "error") {
    return (
      <p className="m-0 text-[var(--ws-danger)] text-xs">{state.message}</p>
    );
  }
  if (!state.connector.configured) {
    return <NotConfigured missing={state.connector.missing} />;
  }
  if (state.bridge) {
    return (
      <BridgeStatus
        agents={agents}
        bridge={state.bridge}
        busy={busy}
        onDisconnect={onDisconnect}
      />
    );
  }
  return <BridgeForm agents={agents} busy={busy} onConnect={onConnect} />;
}
