import { useCallback, useEffect, useState } from "react";
import { Avatar } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { TextField } from "#/components/ui/field";
import type { Agent, Channel } from "#/lib/api";
import { useApi } from "#/lib/workspace-context";

function MemberOption({
  agent,
  checked,
  onToggle,
}: {
  agent: Agent;
  checked: boolean;
  onToggle: (agentId: string) => void;
}) {
  const toggle = useCallback(() => onToggle(agent.id), [agent.id, onToggle]);
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--ws-surface-hover)]">
      <input checked={checked} onChange={toggle} type="checkbox" />
      <Avatar color={agent.avatar} name={agent.name} size="sm" />
      {agent.name}
    </label>
  );
}

export function ChannelDialog({
  agents,
  onClose,
  onCreated,
  open,
}: {
  agents: Agent[];
  onClose: () => void;
  onCreated: (channel: Channel) => Promise<void>;
  open: boolean;
}) {
  const api = useApi();

  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName("");
      setMemberIds([]);
      setError(null);
    }
  }, [open]);

  const toggle = useCallback((agentId: string) => {
    setMemberIds((previous) =>
      previous.includes(agentId)
        ? previous.filter((id) => id !== agentId)
        : [...previous, agentId]
    );
  }, []);

  const onNameChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
    []
  );

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      try {
        await onCreated(await api.createChannel({ agentIds: memberIds, name }));
        onClose();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to create.");
      } finally {
        setBusy(false);
      }
    },
    [api, memberIds, name, onClose, onCreated]
  );

  return (
    <Dialog onClose={onClose} open={open} title="New channel">
      <form className="space-y-4" onSubmit={submit}>
        <TextField
          hint="You are always a member."
          label="Name"
          maxLength={80}
          onChange={onNameChange}
          placeholder="ops"
          required
          value={name}
        />

        <fieldset className="space-y-2 border-0 p-0">
          <legend className="font-medium text-[var(--ws-muted)] text-xs">
            Agents
          </legend>
          {agents.length === 0 ? (
            <p className="m-0 text-[var(--ws-muted)] text-xs">
              No agents yet — create one first.
            </p>
          ) : (
            <ul className="m-0 max-h-56 list-none space-y-1 overflow-y-auto p-0">
              {agents.map((agent) => (
                <li key={agent.id}>
                  <MemberOption
                    agent={agent}
                    checked={memberIds.includes(agent.id)}
                    onToggle={toggle}
                  />
                </li>
              ))}
            </ul>
          )}
        </fieldset>

        {error ? (
          <p className="m-0 text-[var(--ws-danger)] text-xs">{error}</p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose} variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy} type="submit" variant="primary">
            Create channel
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
