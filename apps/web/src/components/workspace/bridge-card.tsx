import { useEffect, useState } from "react";
import type { ChannelBridge, SurfaceStatus } from "#/lib/api";
import { useApi } from "#/lib/workspace-context";

/**
 * "Which surfaces can reach this agent" - the bridge half of the agent's
 * profile. A bridge whose `agentId` is this agent means a Slack mention of the
 * bot in that channel wakes it, exactly like an @mention in our UI.
 */
export function BridgeCard({ agentId }: { agentId: string }) {
  const api = useApi();

  const [bridges, setBridges] = useState<ChannelBridge[] | null>(null);
  const [connector, setConnector] = useState<SurfaceStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .listAgentBridges(agentId)
      .then((data) => {
        if (!cancelled) {
          setBridges(data.bridges);
          setConnector(data.connector);
        }
      })
      .catch(() => {
        // The card is informational; a failed read simply shows nothing.
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, api]);

  return (
    <section className="space-y-1.5" data-testid="agent-bridges">
      <h3 className="m-0 font-medium text-[10px] text-[var(--ws-muted)] uppercase tracking-wide">
        Reachable from
      </h3>
      <BridgeBody bridges={bridges} connector={connector} />
    </section>
  );
}

function BridgeBody({
  bridges,
  connector,
}: {
  bridges: ChannelBridge[] | null;
  connector: SurfaceStatus | null;
}) {
  if (!(bridges && connector)) {
    return <p className="m-0 text-[var(--ws-muted)] text-xs">Loading…</p>;
  }

  if (!connector.configured) {
    return (
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        Slack not configured — set {connector.missing.join(" & ")} to bridge a
        channel to Slack.
      </p>
    );
  }

  if (bridges.length === 0) {
    return (
      <p className="m-0 text-[var(--ws-muted)] text-xs leading-5">
        This workspace only. Bridge a channel to Slack from the channel's
        Settings to let Slack reach this agent.
      </p>
    );
  }

  return (
    <ul className="m-0 list-none space-y-1 p-0">
      {bridges.map((bridge) => (
        <li
          className="flex items-center gap-2 rounded-lg bg-[var(--ws-surface)] px-2 py-1.5 text-[var(--ws-muted)] text-xs"
          key={bridge.id}
        >
          <span className="font-medium text-[var(--ws-text)]">
            {bridge.connector}
          </span>
          <code className="truncate text-[11px]">
            {bridge.externalChannelId}
          </code>
          <span className="ml-auto">{bridge.status}</span>
        </li>
      ))}
    </ul>
  );
}
