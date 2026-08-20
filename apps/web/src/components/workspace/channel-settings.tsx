import type { ChangeEvent } from "react";
import { useCallback, useEffect, useId, useState } from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { TextField } from "#/components/ui/field";
import { Popover } from "#/components/ui/popover";
import type {
  Agent,
  Channel,
  ChannelBridge,
  ChannelMemberView,
  SlackApp,
} from "#/lib/api";
import { memberLabel } from "#/lib/authors";
import { useApi } from "#/lib/workspace-context";

/**
 * The channel's settings pane, reachable from the channel header - who is in
 * the channel and whether it is bridged to Slack are both edited here.
 */

const FALLBACK_COLOR = "#52525b";

type BridgeState =
  | { status: "error"; message: string }
  | { status: "loading" }
  | {
      bridge: ChannelBridge | null;
      slackApps: SlackApp[];
      status: "ready";
    };

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "Something went wrong.";

function NotConfigured() {
  return (
    <p
      className="m-0 text-[var(--ws-muted)] text-xs leading-5"
      data-testid="slack-not-configured"
    >
      No agent is connected to Slack yet. Connect one from its agent settings,
      then bridge this channel to it.
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
  slackApps,
}: {
  agents: Agent[];
  busy: boolean;
  onConnect: (input: { externalChannelId: string; slackAppId: string }) => void;
  slackApps: SlackApp[];
}) {
  const agentSelectId = useId();
  const [externalChannelId, setExternalChannelId] = useState("");
  const [slackAppId, setSlackAppId] = useState(slackApps.at(0)?.id ?? "");

  const submit = useCallback(() => {
    onConnect({ externalChannelId, slackAppId });
  }, [externalChannelId, onConnect, slackAppId]);

  const changeChannelId = useCallback(
    (event: ChangeEvent<HTMLInputElement>) =>
      setExternalChannelId(event.target.value),
    []
  );

  const changeAgent = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) =>
      setSlackAppId(event.target.value),
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
          Bridge through
        </label>
        <select
          className="ws-focus w-full rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-text)] text-sm"
          data-testid="slack-bridge-agent"
          id={agentSelectId}
          onChange={changeAgent}
          value={slackAppId}
        >
          {slackApps.map((app) => (
            <option key={app.id} value={app.id}>
              {agents.find((agent) => agent.id === app.agentId)?.name ??
                "Deleted agent"}
            </option>
          ))}
        </select>
      </div>
      <Button
        disabled={busy || externalChannelId.trim().length === 0 || !slackAppId}
        onClick={submit}
        size="sm"
        variant="primary"
      >
        Connect
      </Button>
    </div>
  );
}

function MemberRow({
  busy,
  member,
  onRemove,
}: {
  busy: boolean;
  member: ChannelMemberView;
  onRemove: (member: ChannelMemberView) => void;
}) {
  // People are named from their membership snapshot, which can be empty; a
  // nameless row that is not a person is an agent whose row is gone.
  const name =
    member.memberType === "user"
      ? memberLabel({ email: member.email ?? "", name: member.name })
      : (member.name ?? "Deleted agent");
  const remove = useCallback(() => onRemove(member), [member, onRemove]);

  return (
    <li className="flex items-center gap-2" data-testid="channel-member">
      <Avatar color={member.avatar ?? FALLBACK_COLOR} name={name} size="sm" />
      <span className="min-w-0 flex-1 truncate text-[13px]">{name}</span>
      <Button
        aria-label={`Remove ${name}`}
        disabled={busy}
        onClick={remove}
        size="sm"
        variant="ghost"
      >
        Remove
      </Button>
    </li>
  );
}

function MembersSection({
  agents,
  busy,
  members,
  onAdd,
  onRemove,
}: {
  agents: Agent[];
  busy: boolean;
  members: ChannelMemberView[];
  onAdd: (agentId: string) => void;
  onRemove: (member: ChannelMemberView) => void;
}) {
  const agentSelectId = useId();
  const [agentId, setAgentId] = useState("");
  const memberIds = new Set(members.map((member) => member.memberId));
  const addable = agents.filter((agent) => !memberIds.has(agent.id));

  const changeAgent = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => setAgentId(event.target.value),
    []
  );

  const add = useCallback(() => {
    onAdd(agentId);
    setAgentId("");
  }, [agentId, onAdd]);

  return (
    <section className="space-y-3" data-testid="channel-members">
      <h2 className="m-0 font-semibold text-[13px]">Members</h2>
      <ul className="m-0 list-none space-y-1 p-0">
        {members.map((member) => (
          <MemberRow
            busy={busy}
            key={`${member.memberType}:${member.memberId}`}
            member={member}
            onRemove={onRemove}
          />
        ))}
      </ul>
      <div className="space-y-1.5">
        <label
          className="block font-medium text-[var(--ws-muted)] text-xs"
          htmlFor={agentSelectId}
        >
          Add agent
        </label>
        <div className="flex items-center gap-2">
          <select
            className="ws-focus min-w-0 flex-1 rounded-lg border border-[var(--ws-line)] bg-[var(--ws-surface)] px-3 py-2 text-[var(--ws-text)] text-sm"
            data-testid="channel-member-agent"
            id={agentSelectId}
            onChange={changeAgent}
            value={agentId}
          >
            <option value="">Pick an agent…</option>
            {addable.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          <Button
            data-testid="channel-member-add"
            disabled={busy || agentId === ""}
            onClick={add}
            size="sm"
            variant="primary"
          >
            Add
          </Button>
        </div>
      </div>
    </section>
  );
}

export function ChannelSettings({
  agents,
  channel,
  members,
  onMembersChange,
}: {
  agents: Agent[];
  channel: Channel;
  members: ChannelMemberView[];
  onMembersChange: (members: ChannelMemberView[]) => void;
}) {
  const api = useApi();

  const channelId = channel.id;
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BridgeState>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const data = await api.getChannelBridge(channelId);
      setState({ ...data, status: "ready" });
    } catch (error) {
      setState({ message: errorMessage(error), status: "error" });
    }
  }, [api, channelId]);

  useEffect(() => {
    if (open) {
      setActionError(null);
      load();
    }
  }, [load, open]);

  const toggle = useCallback(() => setOpen((current) => !current), []);
  const close = useCallback(() => setOpen(false), []);

  const connect = useCallback(
    (input: { externalChannelId: string; slackAppId: string }) => {
      (async () => {
        setBusy(true);
        setActionError(null);
        try {
          await api.saveChannelBridge(channelId, input);
          await load();
        } catch (error) {
          setActionError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, channelId, load]
  );

  const disconnect = useCallback(() => {
    (async () => {
      setBusy(true);
      setActionError(null);
      try {
        await api.deleteChannelBridge(channelId);
        await load();
      } catch (error) {
        setActionError(errorMessage(error));
      } finally {
        setBusy(false);
      }
    })();
  }, [api, channelId, load]);

  const addMember = useCallback(
    (agentId: string) => {
      (async () => {
        setBusy(true);
        setActionError(null);
        try {
          onMembersChange(
            await api.addChannelMember(channelId, {
              memberId: agentId,
              memberType: "agent",
            })
          );
        } catch (error) {
          setActionError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, channelId, onMembersChange]
  );

  const removeMember = useCallback(
    (member: ChannelMemberView) => {
      (async () => {
        setBusy(true);
        setActionError(null);
        try {
          onMembersChange(
            await api.removeChannelMember(
              channelId,
              member.memberType,
              member.memberId
            )
          );
        } catch (error) {
          setActionError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      })();
    },
    [api, channelId, onMembersChange]
  );

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
        <section className="space-y-4" data-testid="channel-settings">
          {channel.kind === "dm" ? null : (
            <MembersSection
              agents={agents}
              busy={busy}
              members={members}
              onAdd={addMember}
              onRemove={removeMember}
            />
          )}
          <section className="space-y-3">
            <h2 className="m-0 font-semibold text-[13px]">Connect to Slack</h2>
            <SlackSection
              agents={agents}
              busy={busy}
              onConnect={connect}
              onDisconnect={disconnect}
              state={state}
            />
          </section>
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
  onConnect: (input: { externalChannelId: string; slackAppId: string }) => void;
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
  const connected = state.slackApps.filter((app) => app.status === "active");
  if (connected.length === 0 && !state.bridge) {
    return <NotConfigured />;
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
  return (
    <BridgeForm
      agents={agents}
      busy={busy}
      onConnect={onConnect}
      slackApps={connected}
    />
  );
}
